// Git types shared between server (routes/git.ts) and web (components/splitPane/*).
// Single source of truth — server returns these shapes; web reads them via api.get.
//
// NOTE: legacy exports (GitStatus / GitDiff / GitRevertResult / GitBranch /
// GitBranchesResult / GitSwitchResult) are preserved because vendor
// packages/zn-agent-core/src/opencc-src/... imports them through the bundle
// entry. Only ADD new exports — never remove or rename existing ones.

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

export interface GitRevertResult {
  ok: boolean;
  error?: string;
  isUntracked?: boolean;
}

/**
 * 一条分支记录. `name` 是 `git for-each-ref` 的 refs:short 形式
 * (本地分支 = "main", 远程分支 = "origin/main"). `isCurrent` 标记当前
 * HEAD 所在; `isRemote` 区分本地与远程, 用于 UI 折叠/分组.
 */
export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

export interface GitBranchesResult {
  ok: boolean;
  branches?: GitBranch[];
  /** 非 ok 时填充: not-a-repo / spawn-failed / parse-error. */
  error?: string;
}

export interface GitSwitchResult {
  ok: boolean;
  /** 切换成功后的当前分支; 与请求 name 不一致表示检出 detached HEAD. */
  branch?: string | null;
  /** ok:false 时填充 stderr 摘要或退出码. */
  error?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// New types (2026-09-25) — Git review panel rewrite. Legacy exports above
// stay frozen; everything below is additive.
// ────────────────────────────────────────────────────────────────────────────

/** Top-level tabs in the Git review panel. */
export type GitMode = 'worktrees' | 'changes' | 'commits' | 'branches';

/** One row from `git status --porcelain=v1 -z`. */
export interface GitStatusEntry {
  /** Path as reported by porcelain (rename/copy pairs collapse to the new path). */
  path: string;
  /** Two-letter status `XY` exactly as git emits (e.g. `'M '`, `' M'`, `'A '`, `'??'`). */
  xy: string;
  /** Convenience: true when the staged column is non-space. Mirrors `xy[0] !== ' '`. */
  staged: boolean;
}

/** Result of `gitService.status`. `truncated` fires when an untracked-files flood
 *  exceeds GIT_STATUS_LIMIT so the UI shows a notice instead of locking up (#369). */
export interface GitStatusResult {
  isRepo: boolean;
  branch?: string;
  entries: GitStatusEntry[];
  truncated?: boolean;
  /** Selected repository root. */
  root?: string;
  /** All discovered repo roots (cwd may be a container with multiple checkouts). */
  repositories?: string[];
}

/** Raw worktree row from `git worktree list --porcelain`. Prunable records point
 *  at missing paths and must be filtered before becoming selectable targets. */
export interface GitWorktreeRecord {
  path: string;
  branch: string;
  locked: boolean;
  prunable: boolean;
}

/** A linked checkout enriched with a live change count for the panel. */
export interface GitWorktree {
  path: string;
  branch: string;
  current: boolean;
  /** Staged + unstaged rows. A file touched on both sides counts once. */
  changes: number;
}

/** One row from `git log --pretty=format:...`. */
export interface GitLogEntry {
  /** 7+ char short hash, used as key in commit lists. */
  hash: string;
  /** 40-char full hash — used for `git show <hashFull>`. */
  hashFull: string;
  subject: string;
  author: string;
  /** ISO 8601 author date, e.g. `2024-01-01 10:00:00 +0800`. */
  date: string;
  /** `--decorate=short` output, e.g. `HEAD -> main, origin/main`. */
  refs: string;
}

/** One branch row with upstream tracking. */
export interface GitBranchEntry {
  name: string;
  current: boolean;
  isRemote: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Subject of the branch tip commit, for richer UI. */
  subject?: string;
}

/** Discriminated action payload for `POST /api/git`. All fields optional unless noted. */
export type GitAction =
  | { action: 'is-repo' }
  | { action: 'status'; selected?: string }
  | { action: 'diff'; path: string; staged?: boolean; selected?: string }
  | { action: 'stage'; path: string; selected?: string }
  | { action: 'unstage'; path: string; selected?: string }
  | { action: 'revert'; path: string; selected?: string }
  | { action: 'commit'; message: string; selected?: string }
  | { action: 'log'; count?: number; skip?: number; selected?: string }
  | { action: 'commit-diff'; hash: string; selected?: string }
  | { action: 'branches'; selected?: string }
  | { action: 'checkout'; branch: string }
  | { action: 'worktrees' }
  | { action: 'resolve-worktree'; requested: string };

/** Standard response envelope. Server returns `ok: true` with `data` or `ok: false`
 *  with `error`. The discriminant union keeps old `ok`-shaped clients compatible
 *  (everything that did `if (!res.ok)` keeps working). */
export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };

/** `data` payload union for `POST /api/git` responses. Kept loose: the
 *  same shape `ok: true, data: T` works whether T is a primitive or object. */
export type GitActionData =
  | { kind: 'is-repo'; value: boolean }
  | { kind: 'status'; value: GitStatusResult }
  | { kind: 'diff'; value: { diff: string; isUntracked: boolean } }
  | { kind: 'stage' }
  | { kind: 'unstage' }
  | { kind: 'revert'; value: { isUntracked: boolean } }
  | { kind: 'commit'; value: { branch: string | null } }
  | { kind: 'log'; value: GitLogEntry[] }
  | { kind: 'commit-diff'; value: { diff: string } }
  | { kind: 'branches'; value: GitBranchEntry[] }
  | { kind: 'checkout'; value: { branch: string | null } }
  | { kind: 'worktrees'; value: GitWorktree[] }
  | { kind: 'resolve-worktree'; value: { path: string } };