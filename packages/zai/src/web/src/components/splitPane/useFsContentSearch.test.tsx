// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFsContentSearch } from './useFsContentSearch.js';

describe('useFsContentSearch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('does nothing when cwd is null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useFsContentSearch(null, 'foo'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('does nothing when query is empty after trim', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useFsContentSearch('/repo', '   '));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('does nothing when enabled=false', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() =>
      useFsContentSearch('/repo', 'foo', { enabled: false }),
    );
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
          entries: [
            {
              path: 'foo.ts',
              name: 'foo.ts',
              matches: [{ line: 1, text: 'TODO', submatch: { text: 'TODO', start: 0, end: 4 } }],
            },
          ],
          truncated: false,
          durationMs: 7,
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFsContentSearch('/repo', 'TODO'));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data?.ok).toBe(true);
    expect(result.current.data?.entries?.[0].path).toBe('foo.ts');
    expect(result.current.durationMs).toBe(7);
  });

  test('passes headLimit via query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, entries: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() =>
      useFsContentSearch('/repo', 'foo', { headLimit: 50 }),
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('headLimit=50');
    expect(url).toContain('q=foo');
  });

  test('records error when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFsContentSearch('/repo', 'foo'));
    await waitFor(() => {
      expect(result.current.error).toMatch(/boom/);
    });
    expect(result.current.data).toBeNull();
  });

  test('aborts inflight when enabled flips to false', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise((r) => { resolveFn = r; }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useFsContentSearch('/repo', 'foo', { enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });
    rerender({ enabled: false });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toBeNull();
    // Resolve the dangling request so the harness doesn't leak warnings.
    resolveFn({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, entries: [] }) });
  });
});
