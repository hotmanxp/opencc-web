import { Router, type IRouter, type Request } from 'express';
import { readdir, stat, readFile } from 'node:fs/promises';
import { extname, basename, join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { resolveSafePath } from '../utils/safePath.js';
import type { FsAck, FsEntry, FsFile, FsList, FsSearchEntry, FsSearchResult } from '../../shared/fs.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_LEN = 64;
const WALK_TIMEOUT_MS = 200;
const IGNORED = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache', '.DS_Store',
]);

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.xml',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.sql', '.graphql', '.gql',
  '.env', '.gitignore', '.gitattributes', '.lock',
]);

// Image extensions we know how to MIME-type without sniffing. SVG lives
// here too — it's XML but also a real image, and the renderer should
// show it as a picture, not dump the markup. `.xml` stays in TEXT_EXTS so
// it keeps its syntax-highlight treatment.
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

// HTML extensions: rendered as a base64 data URL with `text/html` mime so
// the client can drop it straight into a sandboxed <iframe>. Lives
// outside TEXT_EXTS / IMAGE_EXTS because it needs the `kind: 'html'`
// discriminator (different render branch, same payload shape as 'image').
const HTML_EXTS = new Set(['.html', '.htm']);

/**
 * Score a fuzzy filename match (subsequence algorithm).
 *
 * Match: each query character must appear in `path` in order, respecting
 * `caseSensitive`. Score bonuses reward:
 *   - contiguous runs (typing the literal substring),
 *   - boundary alignment (matching at start-of-word after /, -, _, .),
 *   - case-exact alignment (typed casing matches the casing in path),
 *   - basename-end alignment (path ends with the literal query).
 *
 * Penalties push shallow paths above deep ones and short above long, so
 * common targets float to the top. Final score may be negative for very
 * long paths matched weakly; callers should run it through `clampScore`.
 *
 * Returns 0 when query is empty or cannot be matched.
 */
export function fuzzyMatchScore(
  query: string,
  path: string,
  caseSensitive: boolean,
): number {
  if (!query) return 0;
  const q = caseSensitive ? query : query.toLowerCase();
  const p = caseSensitive ? path : path.toLowerCase();

  let qi = 0;
  let runScore = 0;
  let boundaryScore = 0;
  let caseScore = 0;
  for (let pi = 0; pi < p.length && qi < q.length; pi++) {
    if (p[pi] !== q[qi]) continue;
    runScore += 5;
    const prev = pi > 0 ? path[pi - 1] : '';
    if (pi === 0 || prev === '/' || prev === '-' || prev === '_' || prev === '.') {
      boundaryScore += 10;
    }
    if (path[pi] === query[qi]) {
      caseScore += 8;
    }
    qi++;
  }
  if (qi < q.length) return 0;

  const basenameEndScore = path.endsWith(query) ? 6 : 0;
  const bonuses = runScore + boundaryScore + caseScore + basenameEndScore;
  const depthPenalty = path.split('/').length * 2;
  const lengthPenalty = path.length;
  return bonuses - depthPenalty - lengthPenalty;
}

/** Clamp a possibly-negative raw score from `fuzzyMatchScore` to non-negative. */
export function clampScore(s: number): number {
  return s > 0 ? s : 0;
}

const MAX_RESULTS = 200;

interface WalkOptions {
  caseSensitive: boolean;
  signal: AbortSignal;
}

interface WalkResult {
  entries: FsSearchEntry[];
  truncated: boolean;
  durationMs: number;
}

/**
 * BFS workspace walk that collects fuzzy filename matches.
 *
 * Skips the same directories as `/fs/list` (the IGNORED set + hidden dirs
 * at depth >= 1). Returns up to MAX_RESULTS top-scoring files, sorted by
 * score desc then path asc. Honors an AbortSignal — when aborted, the
 * recursion is abandoned and the partial result is returned with
 * truncated:true.
 */
export async function walkForSearch(
  absRoot: string,
  query: string,
  options: WalkOptions,
): Promise<WalkResult> {
  const start = Date.now();
  const collected: Array<{ path: string; name: string; score: number }> = [];
  let truncated = false;

  const stack: Array<{ relDir: string; depth: number }> = [{ relDir: '', depth: 0 }];

  outer: while (stack.length > 0) {
    if (options.signal.aborted) {
      truncated = true;
      break;
    }
    const { relDir, depth } = stack.pop()!;
    const absDir = relDir ? join(absRoot, relDir) : absRoot;

    let names: string[];
    try {
      names = await readdir(absDir);
    } catch {
      continue;
    }

    names.sort();

    for (const name of names) {
      if (IGNORED.has(name)) continue;
      if (depth >= 1 && name.startsWith('.')) continue;
      const childAbs = join(absDir, name);
      const childRel = relDir ? `${relDir}${sep}${name}` : name;

      let info;
      try {
        info = await stat(childAbs);
      } catch {
        continue;
      }

      if (info.isDirectory()) {
        stack.push({ relDir: childRel, depth: depth + 1 });
        continue;
      }
      if (!info.isFile()) continue;

      const relPath = childRel.split(sep).join('/');
      const rawScore = fuzzyMatchScore(query, relPath, options.caseSensitive);
      const score = clampScore(rawScore);
      if (score <= 0) continue;

      collected.push({ path: relPath, name, score });
    }
  }

  collected.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  let top = collected;
  if (collected.length > MAX_RESULTS) {
    top = collected.slice(0, MAX_RESULTS);
    truncated = true;
  }

  const entries: FsSearchEntry[] = top.map((c) => ({
    path: c.path,
    name: c.name,
    type: 'file',
    score: c.score,
  }));

  return { entries, truncated, durationMs: Date.now() - start };
}

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
  const isHtml = HTML_EXTS.has(ext);
  if (!TEXT_EXTS.has(ext) && !isImage && !isHtml && !isDotfile) {
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
    if (isHtml) {
      // HTML preview: serve as a base64 data URL with text/html so the
      // client can drop it straight into a sandboxed <iframe>. We keep
      // it as utf8 (not Buffer) so <meta charset> in the document works
      // correctly without re-decoding latin1 → utf8 on the client.
      const content = await readFile(safe.abs, 'utf8');
      const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(content, 'utf8').toString('base64')}`;
      const body: FsFile = {
        ok: true,
        kind: 'html',
        path: safe.abs,
        name: basename(safe.abs),
        size: info.size,
        mtime: info.mtime.toISOString(),
        mime: 'text/html',
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

fsRouter.get('/fs/search', async (req, res) => {
  const ctxVal = ctx(req);
  if (!ctxVal || typeof ctxVal.cwd !== 'string') {
    res.status(500).json({ ok: false, error: 'instance cwd not configured' } satisfies FsSearchResult);
    return;
  }
  const { cwd } = ctxVal;
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const caseSensitive = req.query.case === '1';

  if (!q) {
    res.status(400).json({ ok: false, error: '缺少 q 参数' } satisfies FsSearchResult);
    return;
  }
  if (q.length > MAX_QUERY_LEN) {
    res.status(400).json({ ok: false, error: `q 太长 (>${MAX_QUERY_LEN})` } satisfies FsSearchResult);
    return;
  }

  const safe = resolveSafePath(cwd, '');
  if (!safe.ok) {
    res.status(403).json({ ok: false, error: safe.error } satisfies FsSearchResult);
    return;
  }

  // Intentional: ignore any dir / start / cwd query params — search
  // always anchors at the configured cwd.

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WALK_TIMEOUT_MS);

  try {
    const { entries, truncated, durationMs } = await walkForSearch(safe.abs, q, {
      caseSensitive,
      signal: ac.signal,
    });
    const body: FsSearchResult = {
      ok: true,
      entries,
      truncated: truncated || ac.signal.aborted,
      durationMs,
    };
    res.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: `search 失败: ${message}` } satisfies FsSearchResult);
  } finally {
    clearTimeout(timer);
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
    // x-terminal-emulator is the Debian/Ubuntu convention. The
    // `cd "${abs}" && $SHELL` string is re-parsed by /bin/sh on the
    // launched emulator side, so paths with literal `"` or `$` are
    // technically injection risks. Best-effort for now — hardening
    // (detect gnome-terminal/konsole/xterm and pass argv directly)
    // is a separate, low-priority project.
    openTerminal: { cmd: 'x-terminal-emulator', buildArgs: (abs) => ['-e', `cd "${abs}" && $SHELL`] },
  };
}

// platformCommands() only reads process.platform, so it's stable for the
// lifetime of the process. Hoist it out of the request handlers to avoid
// recomputing the lookup on every /fs/reveal or /fs/open-terminal call.
const PLATFORM_COMMANDS = platformCommands();

function launchPlatformTool(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    // `stdio: 'ignore'` is a Node-supported execFile option but the older
    // @types/node overloads don't list it; cast through `unknown` so the
    // runtime behaviour matches Node's docs. We never read stdout / stderr
    // from this GUI launcher, so 'ignore' is correct here.
    const child = execFile(
      cmd,
      args,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { timeout: REVEAL_TIMEOUT_MS, windowsHide: true, stdio: 'ignore' } as any,
      (err: import('node:child_process').ExecFileException | null) => {
        if (err) {
          if (err.code === 'ENOENT') {
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
  const { cmd, buildArgs } = PLATFORM_COMMANDS.reveal;
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
  const { cmd, buildArgs } = PLATFORM_COMMANDS.openTerminal;
  const result = await launchPlatformTool(cmd, buildArgs(absDir));
  if (!result.ok) {
    res.status(500).json(result satisfies FsAck);
    return;
  }
  res.json({ ok: true } satisfies FsAck);
});

export default fsRouter;