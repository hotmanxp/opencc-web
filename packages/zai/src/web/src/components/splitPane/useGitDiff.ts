import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import type { GitDiff } from '../../../../shared/git.js';

export interface UseGitDiffResult {
  data: GitDiff | null;
  loading: boolean;
  error: string | null;
}

export function useGitDiff(
  cwd: string | null | undefined,
  path: string | null,
): UseGitDiffResult {
  const [data, setData] = useState<GitDiff | null>(null);
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
      .get<GitDiff>(`/git/diff?path=${encodeURIComponent(path)}`)
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
  }, [cwd, path]);

  return { data, loading, error };
}