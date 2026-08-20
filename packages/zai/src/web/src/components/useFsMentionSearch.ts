import { useEffect, useRef, useState } from "react";
import type { FsSearchEntry, FsSearchResult } from "../../../shared/fs.js";

export interface UseFsMentionSearchResult {
  items: FsSearchEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
}

export interface UseFsMentionSearchOptions {
  /** false 时不发起请求,清空列表 — popup 关闭时传 false */
  enabled?: boolean;
  /** 防抖毫秒数,默认 150。短到用户敲一个字后立即看到结果,长到不会
   *  在快速打字时连续触发。设为 0 关闭防抖(测试用)。 */
  debounceMs?: number;
  caseSensitive?: boolean;
}

/**
 * Debounced fuzzy + dir-scoped search hook for the @-mention popup.
 *
 * 与 splitPane 的 `useFsSearch` 不同:
 * - 150ms 防抖(textarea 连续输入场景,不需要每键击触发)
 * - `enabled=false` 时清空列表 + 不发请求(popup 关闭)
 * - 空 query 也发请求:服务端 @-mention 初始(@ 刚敲完)展示 cwd 顶层
 *   条目是核心 UX 路径,所以 empty 不被跳过
 *
 * 通过 monotonic seq 防止 stale 响应覆盖新数据;AbortSignal 在 cleanup
 * 里取消进行中的请求。
 */
export function useFsMentionSearch(
  query: string,
  options: UseFsMentionSearchOptions = {},
): UseFsMentionSearchResult {
  const { enabled = true, debounceMs = 150, caseSensitive = false } = options;
  const [items, setItems] = useState<FsSearchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      seqRef.current++;
      setItems([]);
      setLoading(false);
      setError(null);
      setTruncated(false);
      return;
    }

    const seq = ++seqRef.current;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({ q: query });
      if (caseSensitive) qs.set("case", "1");
      fetch(`/api/fs/search?${qs.toString()}`, { signal: ac.signal })
        .then(async (r) => {
          if (seqRef.current !== seq) return;
          if (!r.ok) throw new Error(`/fs/search HTTP ${r.status}`);
          const json = (await r.json()) as FsSearchResult;
          if (seqRef.current !== seq) return;
          setItems(json.entries ?? []);
          setTruncated(json.truncated ?? false);
          setError(json.ok ? null : json.error ?? "未知错误");
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (seqRef.current === seq) setLoading(false);
        });
    }, debounceMs);

    return () => {
      ac.abort();
      if (timer) clearTimeout(timer);
    };
  }, [query, enabled, debounceMs, caseSensitive]);

  return { items, loading, error, truncated };
}