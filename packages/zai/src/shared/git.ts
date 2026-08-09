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
