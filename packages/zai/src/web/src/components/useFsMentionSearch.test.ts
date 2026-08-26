// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useFsMentionSearch } from "./useFsMentionSearch.js";

interface FetchCall {
  url: string;
  signal: AbortSignal;
}

let fetchMock: ReturnType<typeof vi.fn>;
let lastCalls: FetchCall[];

beforeEach(() => {
  vi.useFakeTimers();
  lastCalls = [];
  fetchMock = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
    lastCalls.push({ url, signal: init?.signal ?? new AbortController().signal });
    return new Response(
      JSON.stringify({
        ok: true,
        entries: [
          { path: "src/foo.ts", name: "foo.ts", type: "file", score: 10 },
          { path: "src", name: "src", type: "dir", score: 5 },
        ],
        truncated: false,
        durationMs: 5,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flush(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useFsMentionSearch", () => {
  test("enabled=false 时不发起请求且清空结果", async () => {
    const { result, rerender } = renderHook(
      ({ q, enabled }) => useFsMentionSearch(q, { enabled }),
      { initialProps: { q: "foo", enabled: false } },
    );
    await flush(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.items).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    // 切到 enabled=true 后才发请求
    rerender({ q: "foo", enabled: true });
    await flush(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("空 query 也会发请求(显示 cwd 顶层)", async () => {
    const { result } = renderHook(() => useFsMentionSearch("", { debounceMs: 50 }));
    await flush(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCalls[0]!.url).toContain("q=");
    expect(result.current.items.length).toBeGreaterThan(0);
  });

  test("非空 query 在 debounce 后才发请求", async () => {
    const { result } = renderHook(() => useFsMentionSearch("foo", { debounceMs: 150 }));
    await flush(50);
    expect(fetchMock).not.toHaveBeenCalled();
    await flush(150);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.items.length).toBe(2);
  });

  test("快速变更 query → 只保留最后一次请求的响应", async () => {
    const { result, rerender } = renderHook(
      ({ q }) => useFsMentionSearch(q, { debounceMs: 100 }),
      { initialProps: { q: "a" } },
    );
    rerender({ q: "ab" });
    await flush(50);
    rerender({ q: "abc" });
    await flush(200);
    // 三次 query,但只有最终请求触发 fetch(前两次被 debounce 重置)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCalls[0]!.url).toContain("q=abc");
    expect(result.current.items.length).toBe(2);
  });

  test("unmount / 重渲时 abort in-flight 请求", async () => {
    // 抓取 hook 内部 AbortController 的 signal:fetchMock 是唯一入口
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(
      (url: string, init?: { signal?: AbortSignal }) => {
        capturedSignal = init?.signal;
        return new Promise<Response>((_, reject) => {
          capturedSignal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      },
    );
    const { rerender } = renderHook(
      ({ q }) => useFsMentionSearch(q, { debounceMs: 50 }),
      { initialProps: { q: "foo" } },
    );
    await flush(100);
    // 此时第一个 fetch 已经发起但还没完成(mock 永远 pending)。
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
    // rerender 触发 cleanup → hook 内部 ac.abort()。
    rerender({ q: "bar" });
    expect(capturedSignal!.aborted).toBe(true);
  });

  test("非 200 → error 状态", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "boom" }), { status: 500 }),
    );
    const { result } = renderHook(() => useFsMentionSearch("foo", { debounceMs: 10 }));
    await flush(50);
    expect(result.current.error).toMatch(/boom|HTTP/);
    expect(result.current.items).toEqual([]);
  });

  test("ok:false 的响应 → error 字段写入但 items 为空", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "permission denied" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { result } = renderHook(() => useFsMentionSearch("foo", { debounceMs: 10 }));
    await flush(50);
    expect(result.current.error).toBe("permission denied");
    expect(result.current.items).toEqual([]);
  });

  test("truncated 字段透传", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          entries: [{ path: "a", name: "a", type: "file", score: 1 }],
          truncated: true,
          durationMs: 5,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { result } = renderHook(() => useFsMentionSearch("foo", { debounceMs: 10 }));
    await flush(50);
    expect(result.current.truncated).toBe(true);
  });

  test("caseSensitive=1 → URL 带 case=1", async () => {
    renderHook(() => useFsMentionSearch("Foo", { debounceMs: 10, caseSensitive: true }));
    await flush(50);
    expect(lastCalls[0]!.url).toContain("case=1");
  });

  test("AbortError 静默忽略(不写 error)", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    const { result } = renderHook(() => useFsMentionSearch("foo", { debounceMs: 10 }));
    await flush(50);
    expect(result.current.error).toBeNull();
  });
});