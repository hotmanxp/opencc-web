// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFsSearch } from './useFsSearch.js';

describe('useFsSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('does nothing when cwd is null', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useFsSearch(null, 'foo'));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('does nothing when query is empty after trim', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useFsSearch('/repo', '   '));
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.data?.ok).toBe(true);
    expect(result.current.data?.entries?.[0].path).toBe('foo.ts');
    expect(result.current.durationMs).toBe(7);
  });

  test('records error when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFsSearch('/repo', 'foo'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.error).toMatch(/boom/);
    expect(result.current.data).toBeNull();
  });
});
