// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGitStatus } from './useGitStatus.js';

vi.mock('../../lib/api.js', () => ({
  api: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

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
  mocks.status.mockResolvedValue({ ok: true, branch: 'main', files: [] });
});

describe('useGitStatus', () => {
  it('does not fetch when cwd is null', () => {
    renderHook(() => useGitStatus(null));
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('fetches gitApi.status on cwd', async () => {
    const { result } = renderHook(() => useGitStatus('/tmp/repo'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.status).toHaveBeenCalledWith('/tmp/repo');
    expect(result.current.data?.branch).toBe('main');
  });

  it('surfaces error string when ok:false', async () => {
    mocks.status.mockResolvedValue({ ok: false, error: 'not a git repository' });
    const { result } = renderHook(() => useGitStatus('/tmp/notrepo'));
    await waitFor(() => expect(result.current.error).toBe('not a git repository'));
  });

  it('surfaces thrown error', async () => {
    mocks.status.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useGitStatus('/tmp/x'));
    await waitFor(() => expect(result.current.error).toBe('network down'));
  });

  it('polls gitApi.status every 5 seconds', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useGitStatus('/tmp/repo'));
      await vi.waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mocks.status).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mocks.status).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll when cwd is null', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useGitStatus(null));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mocks.status).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});