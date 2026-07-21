import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import type { FsFile } from '../../../../shared/fs.js';

export interface UseFsFileResult {
  data: FsFile | null;
  loading: boolean;
  error: string | null;
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
    const seq = ++seqRef.current;
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