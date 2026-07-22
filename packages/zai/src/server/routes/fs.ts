import { Router, type IRouter, type Request } from 'express';
import { readdir, stat, readFile } from 'node:fs/promises';
import { extname, basename, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { resolveSafePath } from '../utils/safePath.js';
import type { FsAck, FsEntry, FsFile, FsList } from '../../shared/fs.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const IGNORED = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache', '.DS_Store',
]);

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.html', '.htm', '.xml',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.sql', '.graphql', '.gql',
  '.env', '.gitignore', '.gitattributes', '.lock',
]);

// Image extensions we know how to MIME-type without sniffing. SVG lives
// here too — it's XML but also a real image, and the renderer should
// show it as a picture, not dump the markup. `.html`/`.xml`/`.htm` stay
// in TEXT_EXTS so they keep their syntax-highlight treatment.
const IMAGE_EXTS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

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
  const base = basename(safe.abs);
  const isDotfile = base.startsWith('.') && base !== '.' && base !== '..';
  const isImage = Object.prototype.hasOwnProperty.call(IMAGE_EXTS, ext);
  if (!TEXT_EXTS.has(ext) && !isImage && !isDotfile) {
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
    if (isImage) {
      // Binary path: read as Buffer, base64-encode into a data URL so
      // the browser can render it without a separate /fs/raw route.
      const buf = await readFile(safe.abs);
      const dataUrl = `data:${IMAGE_EXTS[ext]};base64,${buf.toString('base64')}`;
      const body: FsFile = {
        ok: true,
        kind: 'image',
        path: safe.abs,
        name: basename(safe.abs),
        size: info.size,
        mtime: info.mtime.toISOString(),
        mime: IMAGE_EXTS[ext],
        dataUrl,
      };
      res.json(body);
      return;
    }
    const content = await readFile(safe.abs, 'utf8');
    const body: FsFile = {
      ok: true,
      kind: 'text',
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

const REVEAL_TIMEOUT_MS = 3_000;

function platformCommands(): {
  reveal: { cmd: string; buildArgs: (abs: string) => string[] };
  openTerminal: { cmd: string; buildArgs: (abs: string) => string[] };
} {
  const p = process.platform;
  if (p === 'darwin') {
    return {
      reveal: { cmd: 'open', buildArgs: (abs) => ['-R', abs] },
      openTerminal: { cmd: 'open', buildArgs: (abs) => ['-a', 'Terminal', abs] },
    };
  }
  if (p === 'win32') {
    return {
      reveal: { cmd: 'explorer.exe', buildArgs: (abs) => [`/select,${abs}`] },
      // `start "" "<dir>"` requires cmd.exe shell, so we use cmd /c.
      openTerminal: { cmd: 'cmd', buildArgs: (abs) => ['/c', 'start', '""', abs] },
    };
  }
  // linux / others
  return {
    reveal: { cmd: 'xdg-open', buildArgs: (abs) => [abs] },
    openTerminal: { cmd: 'x-terminal-emulator', buildArgs: (abs) => ['-e', `cd "${abs}" && $SHELL`] },
  };
}

function launchPlatformTool(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: REVEAL_TIMEOUT_MS, windowsHide: true, stdio: 'ignore' },
      (err) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({ ok: false, error: `${cmd} 未找到` });
            return;
          }
          if ((err as { killed?: boolean }).killed) {
            resolve({ ok: false, error: 'timeout' });
            return;
          }
          // ENOENT vs signal-killed aside, `execFile` with `stdio:'ignore'`
          // returns null on success even when the launched GUI exits non-zero,
          // so any non-null `err` here is a real failure.
          resolve({ ok: false, error: (err as Error).message });
          return;
        }
        resolve({ ok: true });
      },
    );
    // Ensure we don't leak handles; spawn detached for GUI tools.
    if (process.platform !== 'win32') child.unref?.();
  });
}

fsRouter.post('/fs/reveal', async (req, res) => {
  const { cwd } = ctx(req);
  const rel = typeof req.body?.path === 'string' ? req.body.path : '';
  if (!rel) {
    res.status(400).json({ ok: false, error: '缺少 path 参数' } satisfies FsAck);
    return;
  }
  const safe = resolveSafePath(cwd, rel);
  if (!safe.ok) {
    // NUL bytes are a malformed-input (400) failure, not a privilege (403)
    // one — the caller hasn't crossed a boundary, they've handed us a
    // string the OS will truncate. resolveSafePath also rejects them so
    // every other endpoint inherits the same defence.
    const status = safe.error.includes('NUL') ? 400 : 403;
    res.status(status).json({ ok: false, error: safe.error } satisfies FsAck);
    return;
  }
  const { cmd, buildArgs } = platformCommands().reveal;
  const result = await launchPlatformTool(cmd, buildArgs(safe.abs));
  if (!result.ok) {
    res.status(500).json(result satisfies FsAck);
    return;
  }
  res.json({ ok: true } satisfies FsAck);
});

fsRouter.post('/fs/open-terminal', async (req, res) => {
  const { cwd } = ctx(req);
  const rel = typeof req.body?.path === 'string' ? req.body.path : '';
  if (!rel) {
    res.status(400).json({ ok: false, error: '缺少 path 参数' } satisfies FsAck);
    return;
  }
  const safe = resolveSafePath(cwd, rel);
  if (!safe.ok) {
    // NUL bytes are a malformed-input (400) failure, not a privilege (403)
    // one — the caller hasn't crossed a boundary, they've handed us a
    // string the OS will truncate. resolveSafePath also rejects them so
    // every other endpoint inherits the same defence.
    const status = safe.error.includes('NUL') ? 400 : 403;
    res.status(status).json({ ok: false, error: safe.error } satisfies FsAck);
    return;
  }
  // For files, open terminal at the parent directory (Linux/Win fallback
  // wouldn't understand a file arg). On macOS, `open -a Terminal <dir>`
  // also wants a directory, so we always compute the dir.
  const absDir = rel && !rel.endsWith('/')
    ? safe.abs.substring(0, safe.abs.lastIndexOf(sep))
    : safe.abs;
  const { cmd, buildArgs } = platformCommands().openTerminal;
  const result = await launchPlatformTool(cmd, buildArgs(absDir));
  if (!result.ok) {
    res.status(500).json(result satisfies FsAck);
    return;
  }
  res.json({ ok: true } satisfies FsAck);
});

export default fsRouter;