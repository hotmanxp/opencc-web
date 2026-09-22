import { Router, type IRouter, type Request } from 'express';
import { readdir, stat, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { expandTilde } from '../utils/expandTilde.js';
import { openWithSystem } from '../utils/openFile.js';
import { classifyKind, IMAGE_EXTS, isPreviewableKind } from '../../shared/fileKind.js';
import type { DesktopFsEntry, DesktopFsList, DesktopFsFile, DesktopOpen } from '../../shared/desktopFs.js';

const router: IRouter = Router();

// 安全模型同 routes/fsPicker.ts:zai 仅监听 localhost,等同本机 ls。
// 但这里要列"文件+目录"(picker 只列目录),因此独立成端点,不动 fsPicker。
// 相对路径经 resolve 解析(相对 server 进程 cwd),不要求客户端传绝对路径。

// 2026-09-21:扩展名表收编到 shared/fileKind.ts(此前这里有一份重复的
// IMAGE/HTML/TEXT 三件套)。保留 toMime —— /desktop/fs/file 的响应语义是
// 「图片/HTML 内联 dataUrl」,仍然只认这三类;文档类不走这个端点,前端直接
// 构造 { kind, path } 让 DocumentPreview 自己拉 /api/fs/raw(见 Desktop.tsx)。
//
// HTML 在 toMime 里返回 'text/html' 而不是 'text/plain',这样前端
// FilePreviewBody 能识别为 html → 用 <iframe sandbox> 渲染。
function toMime(name: string): string | undefined {
  const kind = classifyKind(name);
  if (kind === 'image' || kind === 'html') {
    return kind === 'html' ? 'text/html' : mimeFor(name);
  }
  if (kind === 'text') return 'text/plain';
  return undefined;
}

/** 图片扩展名 → MIME;非图片返回 undefined。 */
function mimeFor(name: string): string | undefined {
  const ext = extname(name).toLowerCase();
  return IMAGE_EXTS[ext];
}

/** 双击是否走应用内预览(而非系统默认应用)。文档类也算 —— 它们由
 *  DocumentPreview 渲染,不走 /desktop/fs/file。 */
function isPreviewable(name: string): boolean {
  return toMime(name) !== undefined || isPreviewableKind(classifyKind(name));
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

function errBody(message: string): DesktopFsList | DesktopFsFile | DesktopOpen {
  return { ok: false, error: message };
}

function normalizePath(raw: string): string {
  if (raw.includes('\x00')) throw Object.assign(new Error('path 含 NUL 字符'), { status: 400 } as { status: number });
  const target = raw === '' ? homedir() : resolve(expandTilde(raw));
  return resolve(target);
}

router.get('/desktop/fs/list', async (req: Request, res) => {
  const raw = typeof req.query.path === 'string' ? req.query.path : '';
  let target: string;
  try {
    target = normalizePath(raw);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return res.status(status).json(errBody((e as Error).message));
  }
  let st;
  try {
    st = await stat(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return res.status(404).json(errBody(`目录不存在: ${target}`));
    if (code === 'EACCES' || code === 'EPERM') return res.status(403).json(errBody(`无权限访问: ${target}`));
    return res.status(500).json(errBody(`stat 失败: ${(e as Error).message}`));
  }
  if (!st.isDirectory()) return res.status(400).json(errBody(`不是目录: ${target}`));
  let dirents;
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return res.status(403).json(errBody(`无权限列出目录: ${target}`));
    return res.status(500).json(errBody(`读取目录失败: ${(e as Error).message}`));
  }
  const entries: DesktopFsEntry[] = [];
  for (const d of dirents) {
    if (d.name === '.' || d.name === '..') continue;
    const child = join(target, d.name);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(child); // 不 follow symlink(fsPicker 同款取舍)
    } catch {
      continue;
    }
    entries.push({ name: d.name, kind: s.isDirectory() ? 'dir' : 'file', path: child, size: s.size, mtime: s.mtimeMs, preview: isPreviewable(d.name) });
  }
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
  );
  const parent = dirname(target) === target ? null : dirname(target);
  const body: DesktopFsList = { ok: true, path: target, home: homedir(), parent, entries };
  res.json(body);
});

router.get('/desktop/fs/file', async (req: Request, res) => {
  const raw = typeof req.query.path === 'string' ? req.query.path : '';
  let target: string;
  try {
    target = normalizePath(raw);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return res.status(status).json(errBody((e as Error).message));
  }
  const mime = toMime(target);
  if (!mime) return res.status(400).json(errBody('该类型暂不支持预览'));
  let buf: Buffer;
  try {
    const st = await stat(target);
    if (!st.isFile()) return res.status(400).json(errBody('不是文件'));
    if (st.size > MAX_FILE_BYTES) return res.status(413).json(errBody(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 限制`));
    buf = await readFile(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return res.status(404).json(errBody('文件不存在'));
    if (code === 'EACCES' || code === 'EPERM') return res.status(403).json(errBody('无权限读取'));
    return res.status(500).json(errBody(`读取失败: ${(e as Error).message}`));
  }
  const body: DesktopFsFile = { ok: true, mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  res.json(body);
});

router.post('/desktop/open', async (req: Request, res) => {
  const raw = typeof req.body?.path === 'string' ? req.body.path : '';
  if (!raw) return res.status(400).json(errBody('path 必须为字符串') as DesktopOpen);
  let target: string;
  try {
    target = normalizePath(raw);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return res.status(status).json(errBody((e as Error).message) as DesktopOpen);
  }
  try {
    const st = await stat(target);
    if (!st.isFile()) return res.status(400).json(errBody('不是文件') as DesktopOpen);
    await openWithSystem(target);
    return res.json({ ok: true } as DesktopOpen);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return res.status(404).json(errBody('文件不存在') as DesktopOpen);
    if (code === 'EACCES' || code === 'EPERM') return res.status(403).json(errBody('无权限访问') as DesktopOpen);
    return res.status(500).json(errBody(`系统打开失败: ${(e as Error).message}`) as DesktopOpen);
  }
});

export default router;
