import { Router, type IRouter, type Request } from 'express';
import { readdir, stat, readFile } from 'node:fs/promises';
import { extname, basename, sep } from 'node:path';
import { resolveSafePath } from '../utils/safePath.js';
import type { FsEntry, FsFile, FsList } from '../../shared/fs.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 3;
const IGNORED = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache', '.DS_Store',
]);

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.sql', '.graphql', '.gql',
  '.env', '.gitignore', '.gitattributes',
]);

interface InstanceContextShape { cwd: string; cwdName: string }
function ctx(req: Request): InstanceContextShape {
  return req.app.locals.instanceContext as InstanceContextShape;
}

function depthOf(rel: string): number {
  if (!rel) return 0;
  return rel.split(sep).filter(Boolean).length;
}

export const fsRouter: IRouter = Router();

fsRouter.get('/fs/list', async (req, res) => {
  const { cwd } = ctx(req);
  const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
  const safe = resolveSafePath(cwd, dir);
  if (!safe.ok) {
    const body: FsList = { ok: false, error: safe.error };
    res.status(403).json(body);
    return;
  }
  if (depthOf(dir) > MAX_DEPTH) {
    const body: FsList = { ok: false, error: `目录深度超过 ${MAX_DEPTH} 层，拒绝展开` };
    res.json(body);
    return;
  }
  let names: string[];
  try {
    names = await readdir(safe.abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const body: FsList = { ok: false, error: '目录不存在' };
      res.status(404).json(body);
      return;
    }
    const body: FsList = { ok: false, error: `读取目录失败：${err instanceof Error ? err.message : String(err)}` };
    res.status(500).json(body);
    return;
  }

  const entries: FsEntry[] = [];
  for (const name of names) {
    if (IGNORED.has(name)) continue;
    // Hide hidden entries below top level so .claude/.config remain
    // visible at dir="" but not deeper.
    if (depthOf(dir) >= 1 && name.startsWith('.')) continue;
    const abs = `${safe.abs}${sep}${name}`;
    let type: 'dir' | 'file';
    let size: number | null;
    try {
      const s = await stat(abs);
      if (s.isDirectory()) { type = 'dir'; size = null; }
      else if (s.isFile()) { type = 'file'; size = s.size; }
      else { continue; }
    } catch {
      continue;
    }
    const relPath = dir ? `${dir}${sep}${name}` : name;
    entries.push({ name, path: relPath.split(sep).join('/'), type, size });
  }
  // dirs first, then files; alphabetical within each.
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const body: FsList = { ok: true, entries };
  res.json(body);
});

fsRouter.get('/fs/file', async (req, res) => {
  const { cwd } = ctx(req);
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  if (!rel) {
    res.status(400).json({ ok: false, error: '缺少 path 参数' } satisfies FsFile);
    return;
  }
  const safe = resolveSafePath(cwd, rel);
  if (!safe.ok) {
    res.status(403).json({ ok: false, error: safe.error } satisfies FsFile);
    return;
  }
  const ext = extname(safe.abs).toLowerCase();
  if (!TEXT_EXTS.has(ext)) {
    res.status(415).json({ ok: false, error: `不支持的文件类型：${ext || '(无扩展名)'}` } satisfies FsFile);
    return;
  }
  let info;
  try {
    info = await stat(safe.abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      res.status(404).json({ ok: false, error: '文件不存在' } satisfies FsFile);
      return;
    }
    res.status(500).json({ ok: false, error: `stat 失败：${err instanceof Error ? err.message : String(err)}` } satisfies FsFile);
    return;
  }
  if (!info.isFile()) {
    res.status(400).json({ ok: false, error: '不是文件' } satisfies FsFile);
    return;
  }
  if (info.size > MAX_FILE_BYTES) {
    const mb = (info.size / 1024 / 1024).toFixed(2);
    res.status(413).json({ ok: false, error: `文件过大 (${mb} MB > 2 MB)，暂不支持预览` } satisfies FsFile);
    return;
  }
  try {
    const content = await readFile(safe.abs, 'utf8');
    const body: FsFile = {
      ok: true,
      path: safe.abs,
      name: basename(safe.abs),
      size: info.size,
      mtime: info.mtime.toISOString(),
      content,
    };
    res.json(body);
  } catch (err) {
    res.status(500).json({ ok: false, error: `读取失败：${err instanceof Error ? err.message : String(err)}` } satisfies FsFile);
  }
});

export default fsRouter;