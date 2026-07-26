import { useEffect, useRef, useState } from 'react';
import type { FsContentSearchResult } from '../../../../shared/fs.js';

export interface UseFsContentSearchOptions {
  /** When false the hook never fires a request and aborts any inflight. */
  enabled?: boolean;
  /** Override default headLimit (server default 200). */
  headLimit?: number;
}

export interface UseFsContentSearchResult {
  data: FsContentSearchResult | null;
  loading: boolean;
  error: string | null;
  durationMs: number | null;
}

const DEBOUNCE_MS = 200;

/**
 * Debounced content (ripgrep) search hook with an `enabled` gate.
 *
 * Differences from useFsSearch:
 *   - adds an `enabled` flag; while false, the hook returns empty state
 *     AND aborts any inflight fetch.
 *   - 200ms debounce + seqRef + AbortController (same template).
 *
 * Uses global `fetch` so AbortSignal can be passed; `api.get` does not
 * accept a signal.
 */
export function useFsContentSearch(
  cwd: string | null,
  query: string,
  options: UseFsContentSearchOptions = {},
): UseFsContentSearchResult {
  const enabled = options.enabled !== false; // default true
  const headLimit = options.headLimit;

  const [data, setData] = useState<FsContentSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || !cwd || !trimmed) {
      // Abort inflight if any, reset state.
      seqRef.current++; // invalidate any pending seq
      setData(null);
      setError(null);
      setLoading(false);
      setDurationMs(null);
      return;
    }

    const seq = ++seqRef.current;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({ q: trimmed });
      if (typeof headLimit === 'number') qs.set('headLimit', String(headLimit));
      const url = `/api/fs/content-search?${qs.toString()}`;
      fetch(url, { signal: ac.signal })
        .then(async (r) => {
          if (seqRef.current !== seq) return;
          if (!r.ok) throw new Error(`/fs/content-search HTTP ${r.status}`);
          const json = (await r.json()) as FsContentSearchResult;
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
      ac.abort();
    };
  }, [cwd, query, enabled, headLimit]);

  return { data, loading, error, durationMs };
}
