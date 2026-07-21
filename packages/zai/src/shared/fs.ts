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
  path?: string;
  name?: string;
  size?: number;
  mtime?: string;
  content?: string;
}
