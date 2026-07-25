import { useEffect, useRef, useState } from 'react';
import type { FsSearchResult } from '../../../../shared/fs.js';

export interface UseFsSearchResult {
  data: FsSearchResult | null;
  loading: boolean;
  error: string | null;
  durationMs: number | null;
}

export interface UseFsSearchOptions {
  caseSensitive?: boolean;
}

const DEBOUNCE_MS = 200;

/**
 * Debounced filename fuzzy search hook.
 *
 * Trims `query` and skips empty values entirely (no fetch fires).
 * When query non-empty + cwd set, waits DEBOUNCE_MS after the latest
 * change before issuing a GET /fs/search. A monotonic seq guards against
 * stale responses overwriting fresh data when query / cwd change.
 *
 * Note: this hook uses the global `fetch` (not the `api` helper) so we can
 * attach an AbortSignal — `api.get` does not accept a signal.
 */
export function useFsSearch(
  cwd: string | null,
  query: string,
  options: UseFsSearchOptions = {},
): UseFsSearchResult {
  const [data, setData] = useState<FsSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!cwd || !trimmed) {
      setData(null);
      setError(null);
      setLoading(false);
      setDurationMs(null);
      return;
    }

    const seq = ++seqRef.current;
    const timer = setTimeout(() => {
      const ac = new AbortController();
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({ q: trimmed });
      if (options.caseSensitive) qs.set('case', '1');
      const url = `/api/fs/search?${qs.toString()}`;
      fetch(url, { signal: ac.signal })
        .then(async (r) => {
          if (seqRef.current !== seq) return;
          if (!r.ok) throw new Error(`/fs/search HTTP ${r.status}`);
          const json = (await r.json()) as FsSearchResult;
          if (seqRef.current !== seq) return;
          setData(json);
          setError(json.ok ? null : json.error ?? '未知错误');
          setDurationMs(json.durationMs ?? null);
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq) return;
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (seqRef.current === seq) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [cwd, query, options.caseSensitive]);

  return { data, loading, error, durationMs };
}
