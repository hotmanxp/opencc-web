// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFsSearch } from './useFsSearch.js';

describe('useFsSearch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('does nothing when cwd is null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useFsSearch(null, 'foo'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('does nothing when query is empty after trim', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useFsSearch('/repo', '   '));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('records data on successful response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          entries: [{ path: 'foo.ts', name: 'foo.ts', type: 'file', score: 50 }],
          truncated: false,
          durationMs: 7,
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFsSearch('/repo', 'foo'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data?.ok).toBe(true);
    expect(result.current.data?.entries?.[0].path).toBe('foo.ts');
    expect(result.current.durationMs).toBe(7);
  });

  test('records error when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFsSearch('/repo', 'foo'));
    await waitFor(() => {
      expect(result.current.error).toMatch(/boom/);
    });
    expect(result.current.data).toBeNull();
  });
});
