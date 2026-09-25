/**
 * Git API client — thin wrapper over `POST /api/git` (single-endpoint with
 * action dispatch). All public methods preserve the legacy signatures that
 * BranchSelector, MobileQuickDrawer, and the review panel rely on so the
 * downstream consumers don't need to change alongside this rewrite.
 */
import { api } from './api.js';
import type {
  GitBranch,
  GitBranchesResult,
  GitBranchEntry,
  GitLogEntry,
  GitRevertResult,
  GitStatus,
  GitStatusEntry,
  GitStatusResult,
  GitSwitchResult,
  GitWorktree,
} from '../../../shared/git.js';

/** Internal: post a body and unwrap the `{ ok, ...data }` envelope into
 *  a discriminated `{ ok: true } | { ok: false, error }` union. */
async function post<T>(body: Record<string, unknown>): Promise<{
  ok: boolean;
  data?: T;
  error?: string;
}> {
  try {
    const res = await api.post<{ ok: boolean; error?: string } & Record<string, unknown>>(
      '/git',
      body,
    );
    if (res.ok) return { ok: true, data: res as T };
    return { ok: false, error: res.error ?? '未知错误' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const gitApi = {
  /** Single-file revert (untracked → unlink, tracked → checkout). */
  revertFile: async (path: string): Promise<GitRevertResult> => {
    const res = await post<{ isUntracked: boolean }>({
      action: 'revert',
      path,
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, isUntracked: res.data?.isUntracked ?? false };
  },

  /** List all branches (local + remote) for `cwd`. */
  listBranches: async (cwd: string): Promise<GitBranchesResult> => {
    const res = await post<{
      branches: Array<{
        name: string;
        current: boolean;
        isRemote: boolean;
        upstream?: string;
        ahead?: number;
        behind?: number;
      }>;
    }>({ action: 'branches', cwd });
    if (!res.ok) return { ok: false, error: res.error };
    // Adapt the richer `GitBranchEntry` to the legacy `GitBranch` shape
    // that BranchSelector still consumes (name / isCurrent / isRemote).
    const branches: GitBranch[] = (res.data?.branches ?? []).map((b) => ({
      name: b.name,
      isCurrent: b.current,
      isRemote: b.isRemote,
    }));
    // Detached state: refname can be the literal "HEAD" — filter it so the
    // selector doesn't show a misleading entry. (Server side already filters
    // HEAD out for legacy endpoints; keep this defensive belt here too.)
    const filtered = branches.filter((b) => b.name !== 'HEAD');
    return { ok: true, branches: filtered };
  },

  /** Rich branch list (with ahead/behind) — for `GitReviewPanel` branches tab. */
  listBranchesRich: async (
    cwd: string,
  ): Promise<{
    ok: boolean;
    branches: GitBranchEntry[];
    error?: string;
  }> => {
    const res = await post<{ branches: GitBranchEntry[] }>({ action: 'branches', cwd });
    if (!res.ok) return { ok: false, branches: [], error: res.error };
    const branches = (res.data?.branches ?? []).filter((b) => b.name !== 'HEAD');
    return { ok: true, branches };
  },

  /** Rich status snapshot (with two-letter `xy` + truncated flag) — for the
   *  new review panel. The legacy `status()` method collapses to the
   *  one-letter `GitStatusChar` and is preserved for old consumers. */
  fetchStatusRich: async (
    cwd: string,
  ): Promise<{
    entries: GitStatusEntry[];
    truncated: boolean;
    branch: string | null;
    repositories: string[];
  }> => {
    const res = await post<{
      branch: string | null;
      entries: GitStatusEntry[];
      truncated: boolean;
      root: string | null;
      repositories: string[];
    }>({ action: 'status', cwd });
    if (!res.ok) {
      return { entries: [], truncated: false, branch: null, repositories: [] };
    }
    return {
      entries: res.data?.entries ?? [],
      truncated: res.data?.truncated ?? false,
      branch: res.data?.branch ?? null,
      repositories: res.data?.repositories ?? [],
    };
  },

  /** Switch to an existing branch. */
  switchBranch: async (cwd: string, name: string): Promise<GitSwitchResult> => {
    const res = await post<{ branch: string | null }>({
      action: 'checkout',
      cwd,
      branch: name,
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, branch: res.data?.branch ?? name };
  },

  /** Probe whether `cwd` is inside any git worktree. */
  isRepo: async (cwd: string): Promise<boolean> => {
    const res = await post<{ isRepo: boolean }>({ action: 'is-repo', cwd });
    return res.ok ? (res.data?.isRepo ?? false) : false;
  },

  /** Full status snapshot (legacy `GitStatus` shape — for any remaining
   *  consumer that needs the `files` list directly). New code should use
   *  `useGitReview` which exposes the richer `GitStatusEntry` rows. */
  status: async (cwd: string): Promise<GitStatus> => {
    const res = await post<GitStatusResult>({ action: 'status', cwd });
    if (!res.ok) return { ok: false, error: res.error };
    const files = (res.data?.entries ?? []).map((e) => ({
      // Collapse the two-letter `xy` to a single status char compatible with
      // `GitStatusChar`. Prefer unstaged (worktree column), fall back to staged.
      path: e.path,
      status: xyToStatusChar(e.xy),
      staged: e.staged,
    }));
    return {
      ok: true,
      branch: res.data?.branch ?? null,
      files,
    };
  },

  /** Diff for one path. `staged:true` reads from the index. */
  diff: async (
    cwd: string,
    path: string,
    options?: { staged?: boolean },
  ): Promise<{ ok: boolean; diff?: string; isUntracked?: boolean; error?: string }> => {
    const res = await post<{ diff: string; isUntracked: boolean }>({
      action: 'diff',
      cwd,
      path,
      staged: options?.staged ?? false,
    });
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      diff: res.data?.diff ?? '',
      isUntracked: res.data?.isUntracked ?? false,
    };
  },

  /** Stage a path. */
  stage: async (cwd: string, path: string): Promise<{ ok: boolean; error?: string }> => {
    const res = await post({ action: 'stage', cwd, path });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  },

  /** Unstage a path. */
  unstage: async (cwd: string, path: string): Promise<{ ok: boolean; error?: string }> => {
    const res = await post({ action: 'unstage', cwd, path });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  },

  /** Commit the staged changes with a message. */
  commit: async (
    cwd: string,
    message: string,
  ): Promise<{ ok: boolean; branch?: string | null; error?: string }> => {
    const res = await post<{ branch: string | null }>({ action: 'commit', cwd, message });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, branch: res.data?.branch ?? null };
  },

  /** List worktrees for `cwd`'s repo. */
  worktrees: async (cwd: string): Promise<{ ok: boolean; worktrees?: GitWorktree[]; error?: string }> => {
    const res = await post<{ worktrees: GitWorktree[] }>({ action: 'worktrees', cwd });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, worktrees: res.data?.worktrees ?? [] };
  },

  /** Resolve a worktree path against the authoritative list (anti-escape). */
  resolveWorktree: async (
    cwd: string,
    requested: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const res = await post<{ path: string }>({ action: 'resolve-worktree', cwd, requested });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, path: res.data?.path };
  },

  /** Commit log (paginated). */
  log: async (
    cwd: string,
    options?: { count?: number; skip?: number },
  ): Promise<{ ok: boolean; entries?: import('../../../shared/git.js').GitLogEntry[]; error?: string }> => {
    const res = await post<{ entries: import('../../../shared/git.js').GitLogEntry[] }>({
      action: 'log',
      cwd,
      count: options?.count,
      skip: options?.skip,
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, entries: res.data?.entries ?? [] };
  },

  /** Diff for a single commit hash. */
  commitDiff: async (
    cwd: string,
    hash: string,
  ): Promise<{ ok: boolean; diff?: string; error?: string }> => {
    const res = await post<{ diff: string }>({ action: 'commit-diff', cwd, hash });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, diff: res.data?.diff ?? '' };
  },
};

/** Collapse a porcelain v1 `XY` pair to the single status char the legacy UI
 *  consumes. Unstaged column takes priority (matches route/git.ts mapStatus). */
function xyToStatusChar(xy: string): 'M' | 'A' | 'D' | '??' {
  const unstaged = xy[1] ?? ' ';
  const staged = xy[0] ?? ' ';
  if (unstaged === '?') return '??';
  if (unstaged !== ' ') {
    if (unstaged === 'M') return 'M';
    if (unstaged === 'A') return 'A';
    if (unstaged === 'D') return 'D';
    return 'M';
  }
  if (staged === 'M') return 'M';
  if (staged === 'A') return 'A';
  if (staged === 'D') return 'D';
  return 'M';
}