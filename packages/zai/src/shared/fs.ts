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
   *  `content` is omitted in the 'image' / 'html' cases. */
  kind?: 'text' | 'image' | 'html';
  path?: string;
  name?: string;
  size?: number;
  mtime?: string;
  content?: string;
  /** MIME type (set when kind === 'image' or 'html'). */
  mime?: string;
  /** Base64 data URL (set when kind === 'image' or 'html'). */
  dataUrl?: string;
}

/**
 * Result of a filename-only fuzzy search.
 * Returned by /api/fs/search and consumed by useFsSearch → FsSearchList.
 */
export interface FsSearchEntry {
  /** Path relative to cwd, joined with forward slashes (POSIX style). */
  path: string;
  /** Basename of the file — used for UI rendering and <mark> highlight alignment. */
  name: string;
  /** Search only ever returns files (not directories). */
  type: 'file';
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
