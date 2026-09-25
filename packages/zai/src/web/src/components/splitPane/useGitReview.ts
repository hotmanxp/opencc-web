import { useCallback, useEffect, useRef, useState } from 'react';
import { gitApi } from '../../lib/gitApi.js';
import type {
  GitBranchEntry,
  GitLogEntry,
  GitMode,
  GitStatusEntry,
  GitWorktree,
} from '../../../../shared/git.js';

/**
 * Unified hook for the Git review panel. Replaces the older `useGitStatus`
 * + `useGitDiff` pair with a single state machine that pulls the right
 * payload per mode and exposes mutation helpers (stage/unstage/revert/
 * commit/checkout/selectWorktree).
 *
 * Polling: only `changes` mode polls (every 5s) because that's the mode
 * the agent actively mutates. Other modes are refetched on demand.
 *
 * `seqRef` protects every async fetch — a slow request resolving after a
 * newer one must not clobber the displayed state.
 */
export interface UseGitReviewArgs {
  cwd: string | null | undefined;
  mode: GitMode;
  selectedPath?: string | null;
  selectedCommit?: string | null;
  selectedWorktree?: string | null;
}

export interface UseGitReviewResult {
  mode: GitMode;
  /** Repository probe (cheap). `false` → render the "not a git repo" hint. */
  isRepo: boolean;
  /** Current branch name. */
  branch: string | null;
  /** Repositories discovered in the cwd container (multi-root scenario). */
  repositories: string[];

  /** Mode-specific list payload. */
  entries: GitStatusEntry[];
  commits: GitLogEntry[];
  branches: GitBranchEntry[];
  worktrees: GitWorktree[];

  /** Right-pane diff (working-tree file or commit). */
  diff: { text: string; isUntracked: boolean; loading: boolean; error: string | null };

  loading: boolean;
  error: string | null;

  refetch: () => void;
  /** Stage a path (changes mode). */
  stage: (path: string) => Promise<void>;
  unstage: (path: string) => Promise<void>;
  revert: (path: string) => Promise<void>;
  commit: (message: string) => Promise<void>;
  checkout: (branch: string) => Promise<void>;
  selectWorktree: (path: string) => Promise<void>;
}

const POLL_INTERVAL_MS = 5_000;

export function useGitReview(args: UseGitReviewArgs): UseGitReviewResult {
  const { cwd, mode, selectedPath = null, selectedCommit = null, selectedWorktree = null } = args;

  const [isRepo, setIsRepo] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<string[]>([]);

  const [entries, setEntries] = useState<GitStatusEntry[]>([]);
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [branches, setBranches] = useState<GitBranchEntry[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);

  const [diff, setDiff] = useState<UseGitReviewResult['diff']>({
    text: '',
    isUntracked: false,
    loading: false,
    error: null,
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const lastRefetchRef = useRef<() => void>(() => {});

  // ── Mode payload fetchers ─────────────────────────────────────────────
  const fetchList = useCallback(async (): Promise<void> => {
    if (!cwd) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      // Always probe worktrees first — the top-bar selector decides whether
      // to show the Worktree tab based on `worktrees.length > 1`, so we need
      // this list regardless of the current mode. Same pattern as
      // DSH-better-sidebar (worktrees drives the selector, not the active tab).
      const wtRes = await gitApi.worktrees(cwd).catch(() => ({ ok: false, worktrees: [] as typeof worktrees }) as { ok: boolean; worktrees?: typeof worktrees });
      if (seqRef.current !== seq) return;
      if (wtRes.ok) {
        setWorktrees(wtRes.worktrees ?? []);
      }

      if (mode === 'changes') {
        const res = await gitApi.status(cwd);
        if (seqRef.current !== seq) return;
        // `gitApi.status` returns the legacy shape; fetch the richer snapshot
        // via a direct POST so the UI gets the two-letter `xy` + truncated
        // flag. (Kept inside the hook so consumers don't see the dance.)
        const rich = await gitApi
          .fetchStatusRich(cwd)
          .catch(() => ({ entries: [], truncated: false, branch: null, repositories: [] }));
        if (seqRef.current !== seq) return;
        if (!res.ok) {
          setError(res.error ?? '读取状态失败');
          setEntries([]);
          setBranch(null);
        } else {
          setError(null);
          setEntries(rich.entries);
          setBranch(rich.branch);
          setRepositories(rich.repositories);
        }
      } else if (mode === 'commits') {
        const res = await gitApi.log(cwd, { count: 50 });
        if (seqRef.current !== seq) return;
        if (!res.ok) {
          setError(res.error ?? '读取提交历史失败');
          setCommits([]);
        } else {
          setError(null);
          setCommits(res.entries ?? []);
        }
      } else if (mode === 'branches') {
        const res = await gitApi.listBranchesRich(cwd);
        if (seqRef.current !== seq) return;
        if (!res.ok) {
          setError(res.error ?? '读取分支列表失败');
          setBranches([]);
        } else {
          setError(null);
          setBranches(res.branches);
        }
      } else if (mode === 'worktrees') {
        // Already fetched above — keep the worktrees list populated for the
        // right pane as well.
      }
    } finally {
      if (seqRef.current === seq) setLoading(false);
    }
  }, [cwd, mode]);

  lastRefetchRef.current = fetchList;

  const refetch = useCallback(() => {
    void lastRefetchRef.current();
  }, []);

  // ── Diff fetcher (file or commit) ─────────────────────────────────────
  useEffect(() => {
    if (!cwd) {
      setDiff({ text: '', isUntracked: false, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setDiff({ text: '', isUntracked: false, loading: true, error: null });
    const run = async (): Promise<void> => {
      try {
        if (mode === 'changes' && selectedPath) {
          const res = await gitApi.diff(cwd, selectedPath);
          if (cancelled) return;
          if (!res.ok) {
            setDiff({ text: '', isUntracked: false, loading: false, error: res.error ?? '读取 diff 失败' });
          } else {
            setDiff({
              text: res.diff ?? '',
              isUntracked: res.isUntracked ?? false,
              loading: false,
              error: null,
            });
          }
        } else if (mode === 'commits' && selectedCommit) {
          const res = await gitApi.commitDiff(cwd, selectedCommit);
          if (cancelled) return;
          if (!res.ok) {
            setDiff({ text: '', isUntracked: false, loading: false, error: res.error ?? '读取 commit diff 失败' });
          } else {
            setDiff({
              text: res.diff ?? '',
              isUntracked: false,
              loading: false,
              error: null,
            });
          }
        } else {
          setDiff({ text: '', isUntracked: false, loading: false, error: null });
        }
      } catch (err) {
        if (cancelled) return;
        setDiff({
          text: '',
          isUntracked: false,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [cwd, mode, selectedPath, selectedCommit]);

  // ── Initial isRepo probe + poll loop ──────────────────────────────────
  useEffect(() => {
    if (!cwd) {
      setIsRepo(false);
      return;
    }
    void gitApi.isRepo(cwd).then(setIsRepo);
  }, [cwd]);

  useEffect(() => {
    void fetchList();
    if (!cwd) return;
    // Only poll the changes view — other modes don't churn fast enough to
    // warrant a 5s timer. Manual `refetch()` covers the rest.
    if (mode !== 'changes') return;
    const id = setInterval(() => {
      void fetchList();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchList, cwd, mode]);

  // ── Mutations ─────────────────────────────────────────────────────────
  const stage = useCallback(
    async (path: string): Promise<void> => {
      if (!cwd) return;
      const res = await gitApi.stage(cwd, path);
      if (!res.ok) throw new Error(res.error ?? 'stage 失败');
      refetch();
    },
    [cwd, refetch],
  );

  const unstage = useCallback(
    async (path: string): Promise<void> => {
      if (!cwd) return;
      const res = await gitApi.unstage(cwd, path);
      if (!res.ok) throw new Error(res.error ?? 'unstage 失败');
      refetch();
    },
    [cwd, refetch],
  );

  const revert = useCallback(
    async (path: string): Promise<void> => {
      if (!cwd) return;
      const res = await gitApi.revertFile(path);
      if (!res.ok) throw new Error(res.error ?? '撤销失败');
      refetch();
    },
    [cwd, refetch],
  );

  const commit = useCallback(
    async (message: string): Promise<void> => {
      if (!cwd) return;
      const res = await gitApi.commit(cwd, message);
      if (!res.ok) throw new Error(res.error ?? 'commit 失败');
      refetch();
    },
    [cwd, refetch],
  );

  const checkout = useCallback(
    async (branchName: string): Promise<void> => {
      if (!cwd) return;
      const res = await gitApi.switchBranch(cwd, branchName);
      if (!res.ok) throw new Error(res.error ?? '切换分支失败');
      refetch();
    },
    [cwd, refetch],
  );

  const selectWorktree = useCallback(
    async (path: string): Promise<void> => {
      if (!cwd) return;
      const res = await gitApi.resolveWorktree(cwd, path);
      if (!res.ok) throw new Error(res.error ?? 'worktree 切换失败');
      refetch();
    },
    [cwd, refetch],
  );

  return {
    mode,
    isRepo,
    branch,
    repositories,
    entries,
    commits,
    branches,
    worktrees,
    diff,
    loading,
    error,
    refetch,
    stage,
    unstage,
    revert,
    commit,
    checkout,
    selectWorktree,
  };
}