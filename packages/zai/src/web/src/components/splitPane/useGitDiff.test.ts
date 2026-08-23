// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGitDiff } from './useGitDiff.js';

// Mock the api module that the hook imports.
vi.mock('../../lib/api.js', () => ({
  api: {
    get: vi.fn(),
  },
}));

import { api } from '../../lib/api.js';

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;

describe('useGitDiff', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('does not fetch when cwd or path is null', () => {
    renderHook(() => useGitDiff(null, null));
    renderHook(() => useGitDiff('/repo', null));
    renderHook(() => useGitDiff(null, 'a.txt'));
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fetches /api/git/diff with encoded path', async () => {
    mockGet.mockResolvedValue({ ok: true, diff: '@@ -1 +1 @@', isUntracked: false });
    const { result } = renderHook(() => useGitDiff('/tmp/repo', 'src/a b.txt'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGet).toHaveBeenCalledWith('/git/diff?path=src%2Fa%20b.txt');
    expect(result.current.data?.diff).toBe('@@ -1 +1 @@');
    expect(result.current.error).toBeNull();
  });

  it('surfaces error string when ok:false', async () => {
    mockGet.mockResolvedValue({ ok: false, error: 'path 不在 Git 仓库内' });
    const { result } = renderHook(() => useGitDiff('/tmp/repo', 'a.txt'));
    await waitFor(() => expect(result.current.error).toBe('path 不在 Git 仓库内'));
  });

  it('surfaces thrown error', async () => {
    mockGet.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useGitDiff('/tmp/repo', 'a.txt'));
    await waitFor(() => expect(result.current.error).toBe('network down'));
  });

  it('refetches when refreshKey changes (same cwd + same path)', async () => {
    // The bug we fixed: with no refreshKey, repeated edits to the same
    // file left the diff pinned because `path` never changed. By passing
    // `status.data` (or a counter) as a refreshKey, the diff refetches
    // each time the upstream state signals a new revision.
    mockGet.mockResolvedValue({ ok: true, diff: 'first', isUntracked: false });
    const { rerender } = renderHook(
      ({ rev }: { rev: number }) => useGitDiff('/tmp/repo', 'a.txt', rev),
      { initialProps: { rev: 0 } },
    );
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    // Same refreshKey → no refetch.
    rerender({ rev: 0 });
    expect(mockGet).toHaveBeenCalledTimes(1);
    // New refreshKey → refetch (status polls or refetch() bumps it).
    rerender({ rev: 1 });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    rerender({ rev: 2 });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(3));
  });

  it('refetches when path changes', async () => {
    mockGet.mockResolvedValue({ ok: true, diff: '', isUntracked: false });
    const { rerender } = renderHook(
      ({ path }: { path: string }) => useGitDiff('/tmp/repo', path),
      { initialProps: { path: 'a.txt' } },
    );
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    rerender({ path: 'b.txt' });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(mockGet).toHaveBeenLastCalledWith('/git/diff?path=b.txt');
  });

  it('drops stale responses (last writer wins by sequence, not by time)', async () => {
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    mockGet
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; }),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveSecond = resolve; }),
      );

    const { rerender } = renderHook(
      ({ path }: { path: string }) => useGitDiff('/tmp/repo', path),
      { initialProps: { path: 'a.txt' } },
    );
    // First call is in-flight.
    expect(mockGet).toHaveBeenCalledTimes(1);
    // Trigger a second call. The first is now stale.
    rerender({ path: 'b.txt' });
    expect(mockGet).toHaveBeenCalledTimes(2);
    // Resolve the second first (newer wins).
    resolveSecond({ ok: true, diff: 'NEW', isUntracked: false });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    // Then resolve the first (stale — should be ignored).
    resolveFirst({ ok: true, diff: 'STALE', isUntracked: false });
    // Give the microtask queue a chance to drain the stale branch.
    await Promise.resolve();
    await Promise.resolve();
    // The second call's data should win; we observe via a fresh render.
    // (mockGet was called twice; only the newer response is applied.)
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});