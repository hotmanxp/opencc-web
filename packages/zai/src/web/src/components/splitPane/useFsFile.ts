import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import type { FsFile } from '../../../../shared/fs.js';
import { classifyKind } from '../../../../shared/fileKind.js';

export interface UseFsFileResult {
  data: FsFile | null;
  loading: boolean;
  error: string | null;
}

// Pull off the trailing extension (lowercased, including the leading `.`).
// Pure string split — we only need the basename's tail, basename uses
// POSIX separators inside FsTab paths so `'/'` is enough.
function extOf(basename: string): string {
  const idx = basename.lastIndexOf('.');
  return idx <= 0 ? '' : basename.slice(idx).toLowerCase();
}

// Pre-flight: match the server's allow-list (`packages/zai/src/server/
// routes/fs.ts`, TEXT_EXTS / IMAGE_EXTS / HTML_EXTS / dotfile). When a
// file is clearly outside the supported set (e.g. `.zip`, `.docx`,
// extension-less binaries), we surface "不支持的文件类型: xxx" in the
// right-hand panel instead of round-tripping to /api/fs/file just to
// receive a 415 + AntD notification.
function preflightUnsupported(path: string): string | null {
  const base = path.split('/').pop() ?? path;
  const isDotfile = base.startsWith('.') && base !== '.' && base !== '..';
  // Dotfiles bypass the extension allow-list on the server — keep that
  // contract here too so a `.npmrc` still loads.
  if (isDotfile) return null;
  const kind = classifyKind(base);
  if (kind === 'binary') {
    return `不支持的文件类型：${extOf(base) || '(无扩展名)'}`;
  }
  return null;
}

export function useFsFile(
  cwd: string | null | undefined,
  path: string | null,
): UseFsFileResult {
  const [data, setData] = useState<FsFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!cwd || !path) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const blocked = preflightUnsupported(path);
    const seq = ++seqRef.current;
    if (blocked) {
      // Clear any previous result, surface the message inline, and
      // skip the network call entirely. Server-side rejection (e.g. dotfile
      // that's too large) still flows through the .catch() path below.
      setData(null);
      setError(blocked);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .get<FsFile>(`/fs/file?path=${encodeURIComponent(path)}`)
      .then((res) => {
        if (seqRef.current !== seq) return;
        // ok:false responses are emitted as 200 by the server; the api helper
        // unwraps them and we surface `error` directly to the caller.
        setData(res);
        setError(res.ok ? null : res.error ?? '未知错误');
      })
      .catch((err) => {
        if (seqRef.current !== seq) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seqRef.current === seq) setLoading(false);
      });
  }, [cwd, path]);

  return { data, loading, error };
}