import { Router, type IRouter } from 'express';
import { mkdir, readFile, stat, unlink, writeFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';
import type { DesktopWallpaperPut } from '../../shared/desktopFs.js';

/**
 * 桌面壁纸持久化 — 上传的图片以文件形式存 ~/.zai/desktop/wallpapers/,
 * 前端 localStorage 只保存 /api/desktop/wallpaper/<id> URL。
 *
 * 为什么不走 localStorage:壁纸 dataURL(图片 base64)动辄数 MB,会撞
 * localStorage ~5MB quota(写入静默失败,刷新后壁纸丢失);且历史版本曾在
 * FileReader 回调里给 React 合成事件 e.target.value 赋值,抛
 * InvalidStateError 导致整棵组件树卸载("桌面内容被清空")。
 *
 * 目录内文件带随机后缀 id,天然不可变 → GET 响应 Cache-Control immutable;
 * 每次 PUT 成功后清理目录内其余旧壁纸(当前生效壁纸文件同被清理也没关系,
 * 换 wallpaper URL 即换文件)。
 */
const router: IRouter = Router();

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
};
const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([m, e]) => [e, m]),
);
const MAX_WALLPAPER_BYTES = 20 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * oc-004(2026-10-16):旧实现里清理是 `void readdir(dir)` fire-and-forget,
 * 与写入之间**没有任何互斥** —— N 个并发 PUT 各自写完自己的文件后各起一次
 * 清理,最后落地的那次会把同批其余 N-1 个文件全删掉,而那 N-1 个 PUT 的
 * 响应**早已是 200**。前端把已经失效的 URL 存进 localStorage,此后每次刷新
 * 都是坏图,而 UI 显示「壁纸已更新」—— 实测 6 个并发 PUT 拿到 6 个 404。
 *
 * 现在清理与写入共用一把互斥(`withWallpaperLock`),并且只删「上传窗口」
 * 之外的文件:每次写入把文件名记进该目录的 `protected` 集,清理在最后一次
 * 上传后 `CLEANUP_GRACE_MS` 静默期结束才跑,只删不在 `protected` 里的文件。
 * 于是「响应 200 的那一刻,它的文件一定活着,且此后至少再活一个静默期」,
 * 而顺序上传的旧壁纸照常被回收(单壁纸保留语义不变)。
 */
const CLEANUP_GRACE_MS = 300;

type DirState = {
  /** 上传窗口内写入的文件名 —— 清理不得删 */
  protectedNames: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  /** 已有 sweep 排在锁后面尚未执行 —— 见 armCleanup 的说明。 */
  sweepPending: boolean;
};

const dirLocks = new Map<string, Promise<void>>();
const dirStates = new Map<string, DirState>();

/** 目录级互斥:写入与清理共用,保证清理的 readdir 不会横切一次写入。 */
function withWallpaperLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = dirLocks.get(dir) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // 锁链自身吞掉错误,避免一次失败把后续写入全部卡死
  dirLocks.set(dir, run.then(() => undefined, () => undefined));
  return run;
}

function dirState(dir: string): DirState {
  let st = dirStates.get(dir);
  if (!st) {
    st = { protectedNames: new Set(), timer: null, sweepPending: false };
    dirStates.set(dir, st);
  }
  return st;
}

/** 记下本次写入,并(重)置清理静默期。 */
function armCleanup(dir: string, name: string): void {
  const st = dirState(dir);
  st.protectedNames.add(name);
  // 已有 sweep 在排队(定时器已触发、尚未拿到锁)时**不要**再排一个。排队的
  // sweep 在拿到锁之后才读 protectedNames,所以它必然看得见刚加进去的 name;
  // 再排一个只会让后一个 sweep 在前一个清空保护集之后带着空快照去扫,把刚
  // 返回 200 的文件删掉。
  if (st.sweepPending) return;
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => {
    st.timer = null;
    st.sweepPending = true;
    void withWallpaperLock(dir, () => sweepOldWallpapers(dir))
      .catch(() => undefined)
      .finally(() => { st.sweepPending = false; });
  }, CLEANUP_GRACE_MS);
  st.timer.unref?.();
}

/** 只删本次上传窗口之外、且是已知图片扩展名的旧壁纸。 */
async function sweepOldWallpapers(dir: string): Promise<void> {
  const st = dirState(dir);
  const keep = st.protectedNames;
  st.protectedNames = new Set();
  const names = await readdir(dir);
  await Promise.allSettled(
    names
      .filter((n) => !keep.has(n) && EXT_MIME[extname(n).toLowerCase()] !== undefined)
      .map((n) => unlink(join(dir, n))),
  );
}

/** env ZAI_DATA_DIR 覆盖时每次重读(测试隔离用),与 paths.ts weixin 约定一致 */
function wallpaperDir(): string {
  return join(process.env.ZAI_DATA_DIR || join(homedir(), '.zai'), 'desktop', 'wallpapers');
}

function errBody(message: string): DesktopWallpaperPut {
  return { ok: false, error: message };
}

router.put('/desktop/wallpaper', async (req, res) => {
  const dataUrl = typeof req.body?.dataUrl === 'string' ? req.body.dataUrl : '';
  const m = /^data:(image\/[a-z.+-]+);base64,([\s\S]+)$/i.exec(dataUrl);
  if (!m) return res.status(400).json(errBody('dataUrl 必须是 image/* 的 base64 data URL'));
  const mime = m[1]!.toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) return res.status(400).json(errBody(`不支持的图片类型: ${mime}`));
  let buf: Buffer;
  try {
    buf = Buffer.from(m[2]!, 'base64');
  } catch {
    return res.status(400).json(errBody('base64 解码失败'));
  }
  if (buf.length === 0) return res.status(400).json(errBody('图片内容为空'));
  if (buf.length > MAX_WALLPAPER_BYTES) {
    return res.status(413).json(errBody(`图片超过 ${MAX_WALLPAPER_BYTES / 1024 / 1024}MB 限制`));
  }
  const id = `w${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = wallpaperDir();
  try {
    // 写入与清理共用同一把目录锁(oc-004):并发 PUT 不会互相把对方刚写好的
    // 文件删掉,响应 200 时它的文件必然可读。
    await withWallpaperLock(dir, async () => {
      await mkdir(dir, { recursive: true });
      const name = id + ext;
      await writeFile(join(dir, name), buf);
      armCleanup(dir, name);
    });
  } catch (e) {
    return res.status(500).json(errBody(`保存失败: ${(e as Error).message}`));
  }
  res.json({ ok: true, id, url: `/api/desktop/wallpaper/${id}` } as DesktopWallpaperPut);
});

router.get('/desktop/wallpaper/:id', async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id : '';
  if (!ID_RE.test(id)) return res.status(400).json(errBody('非法壁纸 id'));
  const dir = wallpaperDir();
  let mime: string | undefined;
  let buf: Buffer | undefined;
  for (const ext of Object.keys(EXT_MIME)) {
    try {
      const st = await stat(join(dir, id + ext));
      if (!st.isFile()) continue;
      if (st.size > MAX_WALLPAPER_BYTES) return res.status(413).json(errBody('壁纸过大'));
      buf = await readFile(join(dir, id + ext));
      mime = EXT_MIME[ext];
      break;
    } catch {
      // 该扩展名未命中,继续尝试下一个
    }
  }
  if (!buf || !mime) return res.status(404).json(errBody('壁纸不存在'));
  // 文件名含唯一 id,内容不可变 → 长缓存
  res.setHeader('Content-Type', mime);
  // oc-002(2026-10-16):与 fs.ts:1394-1395 对齐。全服务只有 fs.ts 一处设了
  // 这两道头(无 helmet),壁纸端点曾是唯一同类缺口:MIME_EXT 接受
  // image/svg+xml,而 SVG 内嵌脚本在用户直接导航该 URL 时会以应用 origin
  // 执行。UI 走 CSS background 不执行其中脚本(危害收窄在此),但端点本身
  // 不该依赖调用方恰好是 CSS。
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(buf);
});

export default router;
