// Git types shared between server (routes/git.ts) and web (components/splitPane/*).
// Single source of truth — server returns these shapes; web reads them via api.get.

export type GitStatusChar = 'M' | 'A' | 'D' | '??';

export interface GitStatusFile {
  /** Path relative to cwd, exactly as `git status --porcelain` reports. */
  path: string;
  /** Single-char summary used by the UI to color rows. */
  status: GitStatusChar;
  /** True if there is a staged change for this path. */
  staged: boolean;
}

export interface GitStatus {
  ok: boolean;
  error?: string;
  branch?: string | null;
  files?: GitStatusFile[];
}

export interface GitDiff {
  ok: boolean;
  error?: string;
  diff?: string;
  isUntracked?: boolean;
}
