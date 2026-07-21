import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import type { GitStatus } from '../../../../shared/git.js';

export interface UseGitStatusResult {
  data: GitStatus | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useGitStatus(cwd: string | null | undefined): UseGitStatusResult {
  const [data, setData] = useState<GitStatus | null>(null);
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
      .get<GitStatus>('/git/status')
      .then((res) => {
        if (seqRef.current !== seq) return; // stale
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
  }, [cwd]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, refetch: load };
}