// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../../lib/api.js', () => ({
  api: {
    put: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { api } from '../../lib/api.js';
import { useFsWrite } from './useFsWrite.js';

const mockPut = api.put as unknown as ReturnType<typeof vi.fn>;

describe('useFsWrite', () => {
  beforeEach(() => {
    mockPut.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('calls api.put with /fs/file and body { path, content }', async () => {
    mockPut.mockResolvedValueOnce({ ok: true, mtime: '2026-07-25T00:00:00Z', size: 3 });
    const { result } = renderHook(() => useFsWrite());
    await act(async () => {
      const r = await result.current.save('a.txt', 'hey');
      expect(r).toEqual({ ok: true, mtime: '2026-07-25T00:00:00Z', size: 3 });
    });
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut).toHaveBeenCalledWith('/fs/file', { path: 'a.txt', content: 'hey' });
    expect(result.current.saving).toBe(false);
  });

  test('returns { ok:false, error } when api.put rejects', async () => {
    mockPut.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useFsWrite());
    await act(async () => {
      const r = await result.current.save('a.txt', 'x');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/network down/);
    });
    expect(result.current.saving).toBe(false);
  });

  test('returns { ok:false, error } when server returns { ok:false }', async () => {
    mockPut.mockResolvedValueOnce({ ok: false, error: '权限不足' });
    const { result } = renderHook(() => useFsWrite());
    await act(async () => {
      const r = await result.current.save('a.txt', 'x');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBe('权限不足');
    });
  });

  test('saving flag is true during in-flight request', async () => {
    let resolveSave!: (v: unknown) => void;
    mockPut.mockImplementationOnce(() => new Promise((res) => { resolveSave = res; }));
    const { result } = renderHook(() => useFsWrite());
    let savePromise: Promise<unknown> = Promise.resolve();
    act(() => {
      savePromise = result.current.save('a.txt', 'x');
    });
    expect(result.current.saving).toBe(true);
    await act(async () => {
      resolveSave({ ok: true, mtime: '', size: 1 });
      await savePromise;
    });
    expect(result.current.saving).toBe(false);
  });
});
