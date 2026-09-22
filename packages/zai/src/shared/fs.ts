// Filesystem types shared between server (routes/fs.ts) and web (components/splitPane/*).

export type FsEntryType = 'dir' | 'file';

export interface FsEntry {
  /** Basename of the entry. */
  name: string;
  /** Path relative to cwd, joined with forward slashes. */
  path: string;
  type: FsEntryType;
  /** File size in bytes, null for directories. */
  size: number | null;
}

export interface FsList {
  ok: boolean;
  error?: string;
  entries?: FsEntry[];
}

export interface FsAck {
  ok: boolean;
  error?: string;
}

export interface FsFile {
  ok: boolean;
  error?: string;
  /** Preview kind. 'text' (default for known text extensions) returns
   *  utf8 `content`. 'image' returns base64 `dataUrl` + `mime` for
   *  binary image formats. 'html' is like 'image' but mime is text/html
   *  and the client renders via a sandboxed <iframe> instead of <img>;
   *  `content` is omitted in the 'image' / 'html' cases.
   *
   *  文档类 kind('docx' | 'sheet' | 'ppt' | 'pdf' | 'legacy-office',
   *  2026-09-21)只返回元数据 —— 字节由前端另走 GET /api/fs/raw,
   *  避免 base64 膨胀与主线程解码。 */
  kind?: 'text' | 'image' | 'html' | 'docx' | 'sheet' | 'ppt' | 'pdf' | 'legacy-office';
  path?: string;
  name?: string;
  size?: number;
  mtime?: string;
  content?: string;
  /** MIME type (set when kind === 'image' or 'html'). */
  mime?: string;
  /** Base64 data URL (set when kind === 'image' or 'html'). */
  dataUrl?: string;
  /** 文档类 kind:扩展名前缀(eg. ".docx")。 */
  ext?: string;
}

/**
 * Result of a filename-only fuzzy search.
 * Returned by /api/fs/search and consumed by useFsSearch → FsSearchList.
 */
export interface FsSearchEntry {
  /** Path relative to cwd, joined with forward slashes (POSIX style). */
  path: string;
  /** Basename of the entry — used for UI rendering and <mark> highlight alignment. */
  name: string;
  /** Entry kind. `file` is the historical default; `dir` is added for
   *  the @-mention popup so users can pick a directory and continue
   *  typing the next path segment (e.g. `@src/` then `utils/`). */
  type: 'file' | 'dir';
  /** Fuzzy match score (>= 0). Higher = better. Useful for debugging + tests. */
  score: number;
}

export interface FsSearchResult {
  ok: boolean;
  error?: string;
  entries?: FsSearchEntry[];
  /** True when hit count exceeded MAX_RESULTS or scan timed out. */
  truncated?: boolean;
  /** Elapsed ms since walk started (server-side). For client telemetry. */
  durationMs?: number;
}

/**
 * Result of a content (full-text) search.
 * Returned by /api/fs/content-search and consumed by useFsContentSearch → FsContentSearchList.
 */
export interface FsContentSearchSubmatch {
  /** 命中的子串原文(大小写与原文一致)。 */
  text: string;
  /** 0-based column offset (UTF-8 字节,与 ripgrep --json 一致)。 */
  start: number;
  /** 排除性 end column。 */
  end: number;
}

export interface FsContentSearchMatch {
  /** 1-based line number。 */
  line: number;
  /** 完整行文本(去尾换行,前导空白保留)。 */
  text: string;
  /** 第一个 submatch(本次固定返回单 submatch)。 */
  submatch: FsContentSearchSubmatch;
}

export interface FsContentSearchEntry {
  /** 相对 cwd 的 POSIX 路径(forward-slash)。 */
  path: string;
  /** basename。 */
  name: string;
  /** 该文件的所有命中行(本次只展示首个,排序由 server 完成)。 */
  matches: FsContentSearchMatch[];
}

export interface FsContentSearchResult {
  ok: boolean;
  error?: string;
  entries?: FsContentSearchEntry[];
  /** 命中数超过 headLimit 或超时截断。 */
  truncated?: boolean;
  /** server 端耗时 ms。 */
  durationMs?: number;
}

/**
 * Result of POST /api/fs/upload — drops a dragged file as a copy under
 * `<cwd>/.zai/uploads/` and returns its absolute path (the "文件地址"
 * that gets inserted into the chat input). The browser cannot expose the
 * original system path of a dragged file, so the copy's path is the
 * anchor the agent can Read from.
 */
export interface FsUploadResult {
  ok: boolean;
  error?: string;
  /** Absolute path of the stored copy. */
  absPath?: string;
  /** Path relative to cwd (POSIX separators). */
  relPath?: string;
  /** Final on-disk basename (deduplicated: "a.txt" → "a-1.txt"). */
  name?: string;
  /** Stored size in bytes. */
  size?: number;
}

import type { FilePreviewKind } from './fileKind.js'
export type { FilePreviewKind } from './fileKind.js'

/**
 * /fs/preview 路由成功响应:按 kind 决定 content 字段语义。
 * - 'text' / 'html' → `content` 为 utf8 原文
 * - 'image' → `content` 为 base64(配合 mime 拼 data URL)
 * - 'binary' → 仅返回元数据 + ext
 */
export interface FilePreviewPayload {
  kind: FilePreviewKind
  mime?: string
  content?: string
  size: number
  mtime: number
  ext?: string
}

/**
 * /fs/preview 路由失败响应:HTTP status 携带语义,body 仅供前端展示。
 * `code` 与工具层 `display_files` 的 error.code 对齐,便于 UI 复用同一套 Tag 文案。
 *
 * 2026-09-21 追加(文档预览):
 * - `EUNSUPPORTED`            — 扩展名不在 /fs/raw 白名单内(415)
 * - `EENCRYPTED_OR_LEGACY`    — 容器嗅探命中 OLE,即加密 OOXML 或旧版二进制(415)
 */
export interface FilePreviewError {
  code:
    | 'ENOENT' | 'EACCES' | 'EISDIR' | 'ETOOBIG' | 'EBADREQ' | 'EIO'
    | 'EUNSUPPORTED' | 'EENCRYPTED_OR_LEGACY'
  message: string
  meta?: { size?: number }
  /** 仅 EENCRYPTED_OR_LEGACY:嗅探到的容器('ole')。 */
  container?: string
}

/**
 * Result of POST /api/fs/resolve —— 把 chip 的相对路径按"会话 initCwd / 实例 cwd /
 * gitRoot 内搜索"三级解析,落到一个或多个候选上,客户端据此决定直接打开还是
 * 弹候选选择。响应始终是 200,语义用 ok 字段区分:
 *
 *   - ok: 'exact'      — 唯一命中,客户端直接打开 abs 即可
 *   - ok: 'multiple'   — gitRoot 内搜到多条,客户端展示候选
 *   - ok: false        — 没找到,客户端 message.error(error)
 */
export interface FsResolveCandidate {
  /** 绝对路径,可直接喂给 /api/fs/preview。 */
  abs: string;
  /** 相对 gitRoot 的 POSIX 风格路径,UI 展示用。 */
  rel: string;
}

export type FsResolveResult =
  | { ok: 'exact'; abs: string }
  | { ok: 'multiple'; candidates: FsResolveCandidate[] }
  | { ok: false; code?: 'ENOENT' | 'EACCES' | 'EISDIR' | 'BADREQ' | 'EIO'; error: string };
