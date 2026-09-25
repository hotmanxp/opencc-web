// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGitDiff } from './useGitDiff.js';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  diff: vi.fn(),
}));

vi.mock('../../lib/gitApi.js', () => ({
  gitApi: {
    status: (...args: unknown[]) => mocks.status(...args),
    diff: (...args: unknown[]) => mocks.diff(...args),
  },
}));

beforeEach(() => {
  mocks.status.mockReset();
  mocks.diff.mockReset();
});

describe('useGitDiff', () => {
  it('does not fetch when path is null', () => {
    renderHook(() => useGitDiff('/tmp/repo', null));
    expect(mocks.diff).not.toHaveBeenCalled();
  });

  it('fetches gitApi.diff on (cwd, path)', async () => {
    mocks.diff.mockResolvedValue({ ok: true, diff: 'patch', isUntracked: false });
    const { result } = renderHook(() => useGitDiff('/tmp/repo', 'a.txt'));
    await waitFor(() => expect(result.current.data?.diff).toBe('patch'));
    expect(mocks.diff).toHaveBeenCalledWith('/tmp/repo', 'a.txt');
  });

  it('clears data when path becomes null', async () => {
    mocks.diff.mockResolvedValue({ ok: true, diff: 'patch', isUntracked: false });
    const { result, rerender } = renderHook(
      ({ path }: { path: string | null }) => useGitDiff('/tmp/repo', path),
      { initialProps: { path: 'a.txt' as string | null } },
    );
    await waitFor(() => expect(result.current.data).not.toBeNull());
    rerender({ path: null });
    expect(result.current.data).toBeNull();
  });

  it('surfaces error string when ok:false', async () => {
    mocks.diff.mockResolvedValue({ ok: false, error: 'diff too big' });
    const { result } = renderHook(() => useGitDiff('/tmp/repo', 'a.txt'));
    await waitFor(() => expect(result.current.error).toBe('diff too big'));
  });
});