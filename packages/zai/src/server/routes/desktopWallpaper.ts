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
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, id + ext), buf);
  } catch (e) {
    return res.status(500).json(errBody(`保存失败: ${(e as Error).message}`));
  }
  // 尽力清理旧壁纸,失败不影响本次上传结果
  void readdir(dir)
    .then((names) =>
      Promise.allSettled(
        names
          .filter((n) => n !== id + ext && EXT_MIME[extname(n).toLowerCase()] !== undefined)
          .map((n) => unlink(join(dir, n))),
      ),
    )
    .catch(() => undefined);
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
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(buf);
});

export default router;
