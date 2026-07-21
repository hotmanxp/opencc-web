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

export interface FsFile {
  ok: boolean;
  error?: string;
  /** Preview kind. 'text' (default for known text extensions) returns
   *  utf8 `content`. 'image' returns base64 `dataUrl` + `mime` for
   *  binary image formats; `content` is omitted in that case. */
  kind?: 'text' | 'image';
  path?: string;
  name?: string;
  size?: number;
  mtime?: string;
  content?: string;
  /** Image MIME type (only set when kind === 'image'). */
  mime?: string;
  /** Base64 data URL for the image (only set when kind === 'image'). */
  dataUrl?: string;
}
