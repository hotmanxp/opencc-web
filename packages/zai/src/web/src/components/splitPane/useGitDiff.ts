import { useEffect, useRef, useState } from 'react';
import { gitApi } from '../../lib/gitApi.js';
import type { GitDiff } from '../../../../shared/git.js';

/**
 * Thin wrapper around `gitApi.diff(cwd, path)` — re-fetches on path/cwd
 * change. Kept as a separate hook for MobileQuickDrawer's Git tab so the
 * review panel (`useGitReview`) doesn't have to fork its mode machinery
 * just to expose a single-file diff.
 */
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
    gitApi
      .diff(cwd, path)
      .then((res) => {
        if (seqRef.current !== seq) return;
        if (res.ok) {
          setData({
            ok: true,
            diff: res.diff,
            isUntracked: res.isUntracked,
          });
          setError(null);
        } else {
          setData(null);
          setError(res.error ?? '未知错误');
        }
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