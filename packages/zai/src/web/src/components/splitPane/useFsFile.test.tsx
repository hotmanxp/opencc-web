// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useFsFile } from './useFsFile.js';

describe('useFsFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('does nothing when cwd is null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useFsFile(null, 'foo.ts'));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('does nothing when path is null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useFsFile('/repo', null));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Pre-flight guard: clicking a file outside the server's allow-list
  // (e.g. extension-less binaries, .zip, .docx) must not trigger a
  // network request — the right panel surfaces "不支持的文件类型: ..." inline.
  test('skips fetch for unsupported file types (binary)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result, rerender } = renderHook(
      ({ cwd, path }: { cwd: string | null; path: string | null }) =>
        useFsFile(cwd, path),
      { initialProps: { cwd: '/repo' as string | null, path: null as string | null } },
    );
    rerender({ cwd: '/repo', path: 'scripts/zn-ai' });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.error).toMatch(/不支持的文件类型/);
    expect(result.current.error).toMatch(/无扩展名/);
  });

  test('pre-flight message includes the offending extension', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result, rerender } = renderHook(
      ({ cwd, path }: { cwd: string | null; path: string | null }) =>
        useFsFile(cwd, path),
      { initialProps: { cwd: '/repo' as string | null, path: null as string | null } },
    );
    rerender({ cwd: '/repo', path: 'payload.zip' });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.error).toContain('.zip');
  });

  test('still fetches text files', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          kind: 'text',
          path: 'src/index.ts',
          name: 'index.ts',
          content: 'export const x = 1\n',
          size: 17,
          mtime: 0,
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(
      ({ cwd, path }: { cwd: string | null; path: string | null }) =>
        useFsFile(cwd, path),
      { initialProps: { cwd: '/repo' as string | null, path: null as string | null } },
    );
    rerender({ cwd: '/repo', path: 'src/index.ts' });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('path=src%2Findex.ts');
    expect(result.current.error).toBeNull();
    expect(result.current.data?.kind).toBe('text');
  });

  test('still fetches image files', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          kind: 'image',
          path: 'photo.png',
          name: 'photo.png',
          mime: 'image/png',
          dataUrl: 'data:image/png;base64,xxx',
          size: 100,
          mtime: 0,
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(
      ({ cwd, path }: { cwd: string | null; path: string | null }) =>
        useFsFile(cwd, path),
      { initialProps: { cwd: '/repo' as string | null, path: null as string | null } },
    );
    rerender({ cwd: '/repo', path: 'photo.png' });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  // Dotfiles (.npmrc / .gitignore / .env ...) bypass the extension
  // allow-list on the server (TEXT_EXTS does include '.gitignore' /
  // '.env', but not arbitrary dotfiles). Match the server behaviour:
  // dotfiles always pass pre-flight so the server stays the source of
  // truth for them — if it 415's anyway, the existing error path handles it.
  test('still fetches dotfiles', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          kind: 'text',
          path: '.npmrc',
          name: '.npmrc',
          content: 'registry=https://x\n',
          size: 20,
          mtime: 0,
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(
      ({ cwd, path }: { cwd: string | null; path: string | null }) =>
        useFsFile(cwd, path),
      { initialProps: { cwd: '/repo' as string | null, path: null as string | null } },
    );
    rerender({ cwd: '/repo', path: '.npmrc' });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });
});
