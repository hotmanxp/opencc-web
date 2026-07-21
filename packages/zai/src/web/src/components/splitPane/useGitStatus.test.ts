// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGitStatus } from './useGitStatus.js';

// Mock the api module that the hook imports. Stubbing at module level
// avoids spinning up MSW — these are pure happy-dom tests.
vi.mock('../../lib/api.js', () => ({
  api: {
    get: vi.fn(),
  },
}));

import { api } from '../../lib/api.js';

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;

describe('useGitStatus', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('does not fetch when cwd is null', () => {
    renderHook(() => useGitStatus(null));
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fetches /api/git/status on cwd', async () => {
    mockGet.mockResolvedValue({ ok: true, branch: 'main', files: [] });
    const { result } = renderHook(() => useGitStatus('/tmp/repo'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGet).toHaveBeenCalledWith('/git/status');
    expect(result.current.data?.branch).toBe('main');
  });

  it('surfaces error string when ok:false', async () => {
    mockGet.mockResolvedValue({ ok: false, error: 'not a git repository' });
    const { result } = renderHook(() => useGitStatus('/tmp/notrepo'));
    await waitFor(() => expect(result.current.error).toBe('not a git repository'));
  });

  it('surfaces thrown error', async () => {
    mockGet.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useGitStatus('/tmp/x'));
    await waitFor(() => expect(result.current.error).toBe('network down'));
  });

  it('polls /git/status every 5 seconds', async () => {
    vi.useFakeTimers();
    try {
      mockGet.mockResolvedValue({ ok: true, branch: 'main', files: [] });
      renderHook(() => useGitStatus('/tmp/repo'));
      // initial fetch
      await vi.waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
      // advance the 5s interval and the trailing microtasks
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockGet).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockGet).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll when cwd is null', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useGitStatus(null));
      await vi.advanceTimersByTimeAsync(15000);
      expect(mockGet).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});