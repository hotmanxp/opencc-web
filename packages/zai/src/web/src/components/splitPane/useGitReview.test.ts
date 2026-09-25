// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGitReview } from './useGitReview.js';

const mocks = vi.hoisted(() => ({
  isRepo: vi.fn(),
  status: vi.fn(),
  diff: vi.fn(),
  commitDiff: vi.fn(),
  log: vi.fn(),
  listBranchesRich: vi.fn(),
  worktrees: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
  revertFile: vi.fn(),
  commit: vi.fn(),
  switchBranch: vi.fn(),
  resolveWorktree: vi.fn(),
  fetchStatusRich: vi.fn(),
}));

vi.mock('../../lib/gitApi.js', () => ({
  gitApi: {
    isRepo: (...args: unknown[]) => mocks.isRepo(...args),
    status: (...args: unknown[]) => mocks.status(...args),
    diff: (...args: unknown[]) => mocks.diff(...args),
    commitDiff: (...args: unknown[]) => mocks.commitDiff(...args),
    log: (...args: unknown[]) => mocks.log(...args),
    listBranchesRich: (...args: unknown[]) => mocks.listBranchesRich(...args),
    worktrees: (...args: unknown[]) => mocks.worktrees(...args),
    stage: (...args: unknown[]) => mocks.stage(...args),
    unstage: (...args: unknown[]) => mocks.unstage(...args),
    revertFile: (...args: unknown[]) => mocks.revertFile(...args),
    commit: (...args: unknown[]) => mocks.commit(...args),
    switchBranch: (...args: unknown[]) => mocks.switchBranch(...args),
    resolveWorktree: (...args: unknown[]) => mocks.resolveWorktree(...args),
    fetchStatusRich: (...args: unknown[]) => mocks.fetchStatusRich(...args),
  },
}));

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  // Default isRepo stub to true so the hook reaches the list-fetcher path.
  mocks.isRepo.mockResolvedValue(true);
  mocks.fetchStatusRich.mockResolvedValue({
    entries: [],
    truncated: false,
    branch: null,
    repositories: [],
  });
  mocks.status.mockResolvedValue({ ok: true, branch: 'main', files: [] });
  mocks.diff.mockResolvedValue({ ok: true, diff: '', isUntracked: false });
  mocks.log.mockResolvedValue({ ok: true, entries: [] });
  mocks.listBranchesRich.mockResolvedValue({ ok: true, branches: [] });
  mocks.worktrees.mockResolvedValue({ ok: true, worktrees: [] });
});

describe('useGitReview', () => {
  it('does not fetch when cwd is null', () => {
    renderHook(() => useGitReview({ cwd: null, mode: 'changes' }));
    expect(mocks.isRepo).not.toHaveBeenCalled();
    expect(mocks.fetchStatusRich).not.toHaveBeenCalled();
  });

  it('probes isRepo on mount', async () => {
    renderHook(() => useGitReview({ cwd: '/tmp/repo', mode: 'changes' }));
    await waitFor(() => expect(mocks.isRepo).toHaveBeenCalledWith('/tmp/repo'));
  });

  it('loads entries from status in changes mode', async () => {
    mocks.fetchStatusRich.mockResolvedValue({
      entries: [
        { path: 'a.txt', xy: ' M', staged: false },
        { path: 'b.txt', xy: 'M ', staged: true },
      ],
      truncated: false,
      branch: 'main',
      repositories: ['/tmp/repo'],
    });
    const { result } = renderHook(() =>
      useGitReview({ cwd: '/tmp/repo', mode: 'changes' }),
    );
    await waitFor(() => expect(result.current.entries.length).toBe(2));
    expect(result.current.branch).toBe('main');
  });

  it('loads commits from log in commits mode', async () => {
    mocks.log.mockResolvedValue({
      ok: true,
      entries: [{ hashFull: 'abc', subject: 'init', author: 'alice', date: '', refs: '', hash: 'abc' }],
    });
    const { result } = renderHook(() =>
      useGitReview({ cwd: '/tmp/repo', mode: 'commits' }),
    );
    await waitFor(() => expect(result.current.commits.length).toBe(1));
    expect(result.current.commits[0]?.subject).toBe('init');
  });

  it('loads branches from listBranchesRich in branches mode', async () => {
    mocks.listBranchesRich.mockResolvedValue({
      ok: true,
      branches: [{ name: 'main', current: true, isRemote: false }],
    });
    const { result } = renderHook(() =>
      useGitReview({ cwd: '/tmp/repo', mode: 'branches' }),
    );
    await waitFor(() => expect(result.current.branches.length).toBe(1));
    expect(result.current.branches[0]?.current).toBe(true);
  });

  it('loads worktrees from worktrees in worktrees mode', async () => {
    mocks.worktrees.mockResolvedValue({
      ok: true,
      worktrees: [{ path: '/tmp/repo', branch: 'main', current: true, changes: 0 }],
    });
    const { result } = renderHook(() =>
      useGitReview({ cwd: '/tmp/repo', mode: 'worktrees' }),
    );
    await waitFor(() => expect(result.current.worktrees.length).toBe(1));
  });

  it('fetches diff for the selected path in changes mode', async () => {
    mocks.diff.mockResolvedValue({
      ok: true,
      diff: 'diff --git a/a.txt\n+changed',
      isUntracked: false,
    });
    const { result } = renderHook(() =>
      useGitReview({ cwd: '/tmp/repo', mode: 'changes', selectedPath: 'a.txt' }),
    );
    await waitFor(() => expect(result.current.diff.text).toContain('changed'));
  });

  it('fetches commit diff for the selected commit in commits mode', async () => {
    mocks.commitDiff.mockResolvedValue({ ok: true, diff: 'commit patch' });
    const { result } = renderHook(() =>
      useGitReview({ cwd: '/tmp/repo', mode: 'commits', selectedCommit: 'abc123' }),
    );
    await waitFor(() => expect(result.current.diff.text).toBe('commit patch'));
  });

  it('stage() calls gitApi.stage and triggers a refetch', async () => {
    mocks.stage.mockResolvedValue({ ok: true });
    const { result } = renderHook(() =>
      useGitReview({ cwd: '/tmp/repo', mode: 'changes' }),
    );
    await waitFor(() => expect(result.current.entries.length).toBe(0));
    const callsBefore = mocks.fetchStatusRich.mock.calls.length;
    await result.current.stage('a.txt');
    expect(mocks.stage).toHaveBeenCalledWith('/tmp/repo', 'a.txt');
    await waitFor(() =>
      expect(mocks.fetchStatusRich.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it('revert() surfaces server errors via throw', async () => {
    mocks.revertFile.mockResolvedValue({ ok: false, error: 'rm failed' });
    const { result } = renderHook(() =>
      useGitReview({ cwd: '/tmp/repo', mode: 'changes' }),
    );
    await waitFor(() => expect(result.current.entries.length).toBe(0));
    await expect(result.current.revert('a.txt')).rejects.toThrow(/rm failed/);
  });

  it('does not poll when cwd is null', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useGitReview({ cwd: null, mode: 'changes' }));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mocks.fetchStatusRich).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls every 5 seconds in changes mode', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useGitReview({ cwd: '/tmp/repo', mode: 'changes' }));
      await vi.waitFor(() => expect(mocks.fetchStatusRich).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mocks.fetchStatusRich).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll in non-changes modes', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useGitReview({ cwd: '/tmp/repo', mode: 'commits' }));
      await vi.waitFor(() => expect(mocks.log).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(15_000);
      // Only the initial fetch fires; the 5s timer must not reschedule in commits mode.
      expect(mocks.log.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});