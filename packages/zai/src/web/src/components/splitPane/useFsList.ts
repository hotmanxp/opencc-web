import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import type { FsList } from '../../../../shared/fs.js';

export interface UseFsListResult {
  data: FsList | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useFsList(cwd: string | null | undefined, dir: string): UseFsListResult {
  const [data, setData] = useState<FsList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    if (!cwd) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    api
      .get<FsList>(`/fs/list?dir=${encodeURIComponent(dir)}`)
      .then((res) => {
        if (seqRef.current !== seq) return;
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
  }, [cwd, dir]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, refetch: load };
}