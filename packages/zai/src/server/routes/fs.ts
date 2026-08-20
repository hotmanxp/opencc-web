import { Router, type IRouter, type Request } from 'express';
import { readdir, stat, readFile, rm, rmdir, mkdir, writeFile, access } from 'node:fs/promises';
import { extname, basename, join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { resolveSafePath } from '../utils/safePath.js';
import { MAX_FILE_BYTES, writeTextFile } from '../utils/fsWrite.js';
import { resolveRgPath, runRipgrep } from '../services/ripgrep.js';
import type {
  FsAck, FsEntry, FsFile, FsList, FsSearchEntry, FsSearchResult,
  FsContentSearchEntry, FsContentSearchResult, FsUploadResult,
  FilePreviewPayload, FilePreviewError,
} from '../../shared/fs.js';
import { classifyKind, mimeFromExt } from '../../shared/fileKind.js';
import { dirname as pathDirname, relative as pathRelative, resolve as pathResolve } from 'node:path';
const MAX_QUERY_LEN = 64;
const WALK_TIMEOUT_MS = 200;
const IGNORED = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache', '.DS_Store',
]);

// 拖入文件的存放目录(相对 cwd 的 POSIX 路径)。浏览器的 File.path /
// file:// URI 已被现代浏览器移除,拖入文件的系统绝对路径拿不到 ——
// 上传副本落到这里,用副本的绝对路径作为插入对话的「文件地址」,
// agent 拿到后可直接读文件。
const UPLOADS_REL = '.zai/uploads';
// base64 请求体上限:express.json 全局是 20mb,留出 JSON envelope 余量。
const MAX_UPLOAD_BASE64_LEN = 19 * 1024 * 1024;
// 解码后的字节上限(base64 膨胀 ~1.33x 后仍落在 20mb JSON limit 内)。
const MAX_UPLOAD_BYTES = 14 * 1024 * 1024;

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
    // Hide hidden entries below top level so .zai/.config remain
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

fsRouter.put('/fs/file', async (req, res) => {
  const { cwd } = ctx(req);
  const body = req.body ?? {};
  const rel = typeof body.path === 'string' ? body.path : '';
  const content = typeof body.content === 'string' ? body.content : null;
  if (!rel) {
    res.status(400).json({ ok: false, error: '缺少 path 参数' } satisfies FsFile);
    return;
  }
  if (content === null) {
    res.status(400).json({ ok: false, error: '缺少 content 字段' } satisfies FsFile);
    return;
  }
  const safe = resolveSafePath(cwd, rel);
  if (!safe.ok) {
    const status = safe.error.includes('NUL') ? 400 : 403;
    res.status(status).json({ ok: false, error: safe.error } satisfies FsFile);
    return;
  }
  // 扩展名白名单:复用 GET /fs/file 的逻辑(只允许 TEXT_EXTS 内的扩展 + dotfile)
  const ext = extname(safe.abs).toLowerCase();
  const base = basename(safe.abs);
  const isDotfile = base.startsWith('.') && base !== '.' && base !== '..';
  if (!TEXT_EXTS.has(ext) && !isDotfile) {
    res.status(400).json({ ok: false, error: `不允许写入:扩展名 ${ext || '(无)'} 不在白名单` } satisfies FsFile);
    return;
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    const mb = (bytes / 1024 / 1024).toFixed(2);
    res.status(413).json({ ok: false, error: `内容过大 (${mb} MB > 2 MB)` } satisfies FsFile);
    return;
  }
  // PUT requires an existing file (like "save", not "save as")
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
  const result = await writeTextFile(safe.abs, content);
  if (!result.ok) {
    if (result.code === 'ENOENT') {
      res.status(404).json({ ok: false, error: result.error } satisfies FsFile);
      return;
    }
    res.status(500).json({ ok: false, error: result.error } satisfies FsFile);
    return;
  }
  res.json({
    ok: true,
    kind: 'text',
    path: safe.abs,
    name: base,
    size: result.size,
    mtime: result.mtime,
  } satisfies FsFile);
});

/**
 * Sanitize a client-supplied filename for upload: strips directory
 * components (traversal guard — the stored copy always lives inside
 * `<cwd>/.zai/uploads/`), rejects hidden/control-char/oversized names.
 */
function sanitizeUploadName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const cleaned = name.split(/[\\/]/).pop()?.trim() ?? '';
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.length > 200) {
    return null;
  }
  // Control chars can't exist in a real filename and would be ambiguous
  // when the absolute path is later pasted into a chat message.
  if (/[\x00-\x1f\x7f]/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Pick a non-colliding path inside `dir` for `name`: reuse the plain
 * name when free, otherwise append `-1`, `-2`, … before the extension
 * ("a.txt" → "a-1.txt") so repeated drags don't overwrite earlier copies.
 */
async function uniqueUploadPath(dir: string, name: string): Promise<string> {
  const candidate = join(dir, name);
  try {
    await access(candidate);
  } catch {
    return candidate;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i++) {
    const next = join(dir, `${stem}-${i}${ext}`);
    try {
      await access(next);
    } catch {
      return next;
    }
  }
}

// 拖入的非图片文件落到 `<cwd>/.zai/uploads/`,返回副本的绝对路径
// (FsUploadResult.absPath)作为「文件地址」插入对话输入框。
fsRouter.post('/fs/upload', async (req, res) => {
  const { cwd } = ctx(req);
  const body = req.body ?? {};
  if (typeof body.data !== 'string' || !body.data) {
    res.status(400).json({ ok: false, error: '缺少 data 字段' } satisfies FsUploadResult);
    return;
  }
  const name = sanitizeUploadName(body.name);
  if (!name) {
    res.status(400).json({ ok: false, error: '文件名非法' } satisfies FsUploadResult);
    return;
  }
  if (Buffer.byteLength(body.data, 'utf8') > MAX_UPLOAD_BASE64_LEN) {
    res.status(413).json({ ok: false, error: '文件过大 (base64 超出 19 MB)' } satisfies FsUploadResult);
    return;
  }
  // base64 合法性:标准 alphabet + 尾部 padding;非法字符 Buffer.from
  // 会静默丢弃尾部垃圾,必须显式拒绝。
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.data) || body.data.length % 4 !== 0) {
    res.status(400).json({ ok: false, error: 'data 不是合法 base64' } satisfies FsUploadResult);
    return;
  }
  const buf = Buffer.from(body.data, 'base64');
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    const mb = (buf.byteLength / 1024 / 1024).toFixed(2);
    res.status(413).json({ ok: false, error: `文件过大 (${mb} MB > 14 MB)` } satisfies FsUploadResult);
    return;
  }
  const dir = join(cwd, ...UPLOADS_REL.split('/'));
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: `创建上传目录失败: ${err instanceof Error ? err.message : String(err)}` } satisfies FsUploadResult);
    return;
  }
  const absPath = await uniqueUploadPath(dir, name);
  try {
    await writeFile(absPath, buf);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC') {
      res.status(500).json({ ok: false, error: '磁盘空间不足' } satisfies FsUploadResult);
      return;
    }
    res.status(500).json({ ok: false, error: `写入失败: ${err instanceof Error ? err.message : String(err)}` } satisfies FsUploadResult);
    return;
  }
  res.json({
    ok: true,
    absPath,
    relPath: `${UPLOADS_REL}/${basename(absPath)}`,
    name: basename(absPath),
    size: buf.byteLength,
  } satisfies FsUploadResult);
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

// --- Content search (ripgrep-backed) -------------------------------------

const RG_TIMEOUT_MS = 10_000;
const DEFAULT_HEAD_LIMIT = 200;
const MAX_HEAD_LIMIT = 500;
const RG_GLOBS = [
  // Binary / archive
  '--glob', '!*.{png,jpg,jpeg,gif,webp,ico,pdf,zip,tar,gz,wasm,mp3,mp4,avi,mov,ogg,flac,ttf,otf,eot,bin,exe,so,dll,class,o,obj}',
  // VCS
  '--glob', '!{.git,.svn,.hg,.bzr,.jj,.sl}',
  // Deps / build
  '--glob', '!{node_modules,dist,build,coverage,.next,.turbo,.cache}',
];

interface ParsedRgMatch {
  path: string;
  line: number;
  text: string;
  submatch: { text: string; start: number; end: number };
}

function parseRgJsonLine(line: string): ParsedRgMatch | null {
  if (!line) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    typeof obj !== 'object' || obj === null ||
    (obj as { type?: string }).type !== 'match'
  ) {
    return null;
  }
  const o = obj as {
    data?: {
      path?: { text?: string };
      line_number?: number;
      lines?: { text?: string };
      submatches?: Array<{ match?: { text?: string }; start: number; end: number }>;
    };
  };
  const d = o.data;
  if (!d?.path?.text || typeof d.line_number !== 'number' || !d.lines?.text) return null;
  const sub = d.submatches?.[0];
  if (!sub?.match?.text) return null;
  return {
    path: d.path.text,
    line: d.line_number,
    text: d.lines.text.replace(/\r?\n$/, ''),
    submatch: { text: sub.match.text, start: sub.start, end: sub.end },
  };
}

/**
 * Aggregate ripgrep --json output into FsContentSearchEntry[].
 * - Relativises paths against searchRoot, joins POSIX forward-slashes.
 * - Aggregates matches per path.
 * - Sorts entries by matches.length desc, then path asc.
 * - Truncates to headLimit; sets truncated=true if either the headLimit
 *   cut was reached OR a parse error forced early termination.
 */
function aggregateRgOutput(
  stdout: string,
  searchRoot: string,
  headLimit: number,
): { entries: FsContentSearchEntry[]; truncated: boolean } {
  const byPath = new Map<string, ParsedRgMatch[]>();
  let parseErrors = 0;
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    const m = parseRgJsonLine(raw);
    if (!m) {
      parseErrors++;
      continue;
    }
    // Relativise + POSIX join.
    const rel = pathRelative(searchRoot, m.path);
    const relPosix = rel.split(sep).join('/');
    const arr = byPath.get(relPosix);
    if (arr) arr.push(m);
    else byPath.set(relPosix, [m]);
  }

  const allEntries: FsContentSearchEntry[] = [];
  for (const [relPath, matches] of byPath) {
    matches.sort((a, b) => a.line - b.line);
    const name = relPath.includes('/')
      ? relPath.slice(relPath.lastIndexOf('/') + 1)
      : relPath;
    allEntries.push({
      path: relPath,
      name,
      matches: matches.map((m) => ({
        line: m.line,
        text: m.text,
        submatch: m.submatch,
      })),
    });
  }
  allEntries.sort((a, b) => {
    const byCount = b.matches.length - a.matches.length;
    return byCount !== 0 ? byCount : a.path.localeCompare(b.path);
  });

  const truncated = parseErrors > 0 || allEntries.length > headLimit;
  const entries = allEntries.slice(0, headLimit);
  return { entries, truncated };
}

fsRouter.get('/fs/content-search', async (req, res) => {
  const ctxVal = ctx(req);
  if (!ctxVal || typeof ctxVal.cwd !== 'string') {
    res.status(500).json({ ok: false, error: 'instance cwd not configured' } satisfies FsContentSearchResult);
    return;
  }
  const { cwd } = ctxVal;

  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (!q) {
    res.status(400).json({ ok: false, error: '缺少 q 参数' } satisfies FsContentSearchResult);
    return;
  }
  if (q.length > MAX_QUERY_LEN) {
    res.status(400).json({ ok: false, error: `q 太长 (>${MAX_QUERY_LEN})` } satisfies FsContentSearchResult);
    return;
  }

  const safe = resolveSafePath(cwd, '');
  if (!safe.ok) {
    res.status(403).json({ ok: false, error: safe.error } satisfies FsContentSearchResult);
    return;
  }

  const headLimitRaw = parseInt(String(req.query.headLimit ?? ''), 10);
  const headLimit = Number.isFinite(headLimitRaw) && headLimitRaw > 0
    ? Math.min(headLimitRaw, MAX_HEAD_LIMIT)
    : DEFAULT_HEAD_LIMIT;

  const rg = resolveRgPath();
  if (!rg) {
    res.status(200).json({
      ok: false,
      error: 'ripgrep 未安装,内容搜索不可用',
    } satisfies FsContentSearchResult);
    return;
  }

  const startMs = Date.now();
  const ac = new AbortController();
  // Outer timer aborts on top of spawn's own timeout; whichever fires
  // first wins. We expose partial results with truncated:true.
  const outerTimer = setTimeout(() => ac.abort(), RG_TIMEOUT_MS);

  const args = [
    '--json',
    '-n',
    '-i',
    '--max-filesize', '2M',
    ...RG_GLOBS,
    '-e', q,
    safe.abs,
  ];

  let result;
  try {
    result = await runRipgrep(args, { cwd: safe.abs, signal: ac.signal, timeoutMs: RG_TIMEOUT_MS });
  } finally {
    clearTimeout(outerTimer);
  }

  // EAGAIN retry (errno 11) — single-thread rerun, then give up.
  if (
    result.code === 2 &&
    (result.stderr.includes('os error 11') || result.stderr.includes('Resource temporarily unavailable'))
  ) {
    ac.abort();
    const ac2 = new AbortController();
    const outerTimer2 = setTimeout(() => ac2.abort(), RG_TIMEOUT_MS);
    try {
      result = await runRipgrep(['-j', '1', ...args], {
        cwd: safe.abs,
        signal: ac2.signal,
        timeoutMs: RG_TIMEOUT_MS,
      });
    } finally {
      clearTimeout(outerTimer2);
    }
  }

  if (result.error?.code === 'ENOENT' || (result.code !== 0 && result.code !== 1)) {
    res.status(200).json({
      ok: false,
      error: `search 失败: ${result.stderr || result.error?.message || `exit ${result.code}`}`,
    } satisfies FsContentSearchResult);
    return;
  }

  const { entries, truncated } = aggregateRgOutput(result.stdout, safe.abs, headLimit);
  res.json({
    ok: true,
    entries,
    truncated,
    durationMs: Date.now() - startMs,
  } satisfies FsContentSearchResult);
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

// 1 MiB hard cap; matches spec §2 '范围与约束'.
// maxBytes query is clamped into [1024, 1 MiB] so a malicious LLM can't
// bypass via maxBytes=0 or maxBytes=999999999.
const PREVIEW_DEFAULT_MAX = 1_048_576

function clampInt(raw: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN
  if (!Number.isFinite(n)) return fallback
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

function mapStatError(res: import('express').Response, err: unknown): void {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT') {
    res.status(404).json({ error: { code: 'ENOENT', message: '文件不存在' } } satisfies { error: FilePreviewError })
    return
  }
  if (code === 'EACCES' || code === 'EPERM') {
    res.status(403).json({ error: { code: 'EACCES', message: '无权限访问' } } satisfies { error: FilePreviewError })
    return
  }
  res.status(500).json({
    error: {
      code: 'EIO',
      message: `stat 失败:${err instanceof Error ? err.message : String(err)}`,
    },
  } satisfies { error: FilePreviewError })
}

fsRouter.get('/fs/preview', async (req, res) => {
  const { cwd } = ctx(req)
  const raw = typeof req.query.path === 'string' ? req.query.path : ''
  if (!raw) {
    res.status(400).json({ error: { code: 'EBADREQ', message: 'path 必填' } } satisfies { error: FilePreviewError })
    return
  }
  const abs = pathResolve(raw)
  const maxBytes = clampInt(req.query.maxBytes, 1024, PREVIEW_DEFAULT_MAX, PREVIEW_DEFAULT_MAX)
  void cwd // 不限 cwd,但 log 一次便于排查;实际 cwd 记录在 server 日志

  let info
  try {
    info = await stat(abs)
  } catch (err) {
    mapStatError(res, err)
    return
  }
  if (info.isDirectory()) {
    res.status(400).json({ error: { code: 'EISDIR', message: '路径是目录' } } satisfies { error: FilePreviewError })
    return
  }
  if (info.size > maxBytes) {
    res.status(413).json({
      error: {
        code: 'ETOOBIG',
        message: `文件 ${info.size} 字节,超过 ${maxBytes}`,
        meta: { size: info.size },
      },
    } satisfies { error: FilePreviewError })
    return
  }
  const kind = classifyKind(abs)
  if (kind === 'image') {
    const buf = await readFile(abs)
    const mime = mimeFromExt(abs) ?? 'application/octet-stream'
    const payload: FilePreviewPayload = {
      kind,
      mime,
      content: buf.toString('base64'),
      size: info.size,
      mtime: info.mtimeMs,
    }
    res.json(payload)
    return
  }
  if (kind === 'html' || kind === 'text') {
    const text = await readFile(abs, 'utf8')
    const payload: FilePreviewPayload = {
      kind,
      mime: kind === 'html' ? 'text/html' : 'text/plain',
      content: text,
      size: info.size,
      mtime: info.mtimeMs,
    }
    res.json(payload)
    return
  }
  const payload: FilePreviewPayload = {
    kind: 'binary',
    size: info.size,
    mtime: info.mtimeMs,
    ext: extname(abs),
  }
  res.json(payload)
})

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

fsRouter.post('/fs/delete', async (req, res) => {
  const { cwd } = ctx(req);
  const rel = typeof req.body?.path === 'string' ? req.body.path : '';
  if (!rel) {
    res.status(400).json({ ok: false, error: '缺少 path 参数' } satisfies FsAck);
    return;
  }
  const safe = resolveSafePath(cwd, rel);
  if (!safe.ok) {
    const status = safe.error.includes('NUL') ? 400 : 403;
    res.status(status).json({ ok: false, error: safe.error } satisfies FsAck);
    return;
  }
  let info;
  try {
    info = await stat(safe.abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      res.status(404).json({ ok: false, error: '文件不存在' } satisfies FsAck);
      return;
    }
    res.status(500).json({ ok: false, error: `stat 失败：${err instanceof Error ? err.message : String(err)}` } satisfies FsAck);
    return;
  }
  try {
    if (info.isDirectory()) {
      await rmdir(safe.abs);
    } else {
      await rm(safe.abs);
    }
    res.json({ ok: true } satisfies FsAck);
  } catch (err) {
    res.status(500).json({ ok: false, error: `删除失败：${err instanceof Error ? err.message : String(err)}` } satisfies FsAck);
  }
});

export default fsRouter;