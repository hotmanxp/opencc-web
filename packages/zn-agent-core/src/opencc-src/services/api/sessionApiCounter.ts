// zai patch (2026-08-09): per-session API 请求计数器。
//
// 用途: zai 会话信息面板的"API 请求次数"显示需要后端给个真实计数。
// 实施范围:
//   - 只在 claude.ts 3 处真打 AI provider 的入口计 1 次(queryModel 流式
//     主路径 / executeNonStreamingRequest fallback),verifyApiKey 不计
//     (初始化阶段,与"用户 API 请求"语义不同)。
//   - 每次外层入口记 1 次,内部 withRetry 的 429/529 retry 不重复计。
//     这与"用户发 1 条 prompt = 1 次 API 请求"的直觉一致;真实 cost
//     仍可用 token usage(input + cache + output)跟踪,与本计数器正交。
//   - 计数 key 用当前 session(由 zai 服在每次 query 入口通过 setCurrentApiCountSession
//     同步注入 globalThis),session 终止时由 zai 服 clearApiCallCount 显式清零。
//
// 实现: 完全自包含,无任何外部 import — 这样 esbuild bundle:false
// 编出的 dist/.js 不会被 vendor 内部的 'src/...' alias 拖入编译链路
// (zai dev 走 standard Node ESM,没有 tsconfig paths 解析)。用 globalThis
// 同步传 sid(简单,无 ALS 嵌套);zai 服每次 query 入口调一次 set,所有
// claude.ts 内 recordApiCall 同步读到。同一 session 嵌套调用安全(只读最新值)。

// vendor 的 MACRO 里有不少 globalThis.<key> 用途,本模块用一个有命名空间
// 的 key 避免冲突。
declare global {
  // eslint-disable-next-line no-var
  var __zaiApiCountSession: string | undefined
  // eslint-disable-next-line no-var
  var __zaiApiCountLastUsage: { input: number; cache_creation: number; cache_read: number; output: number } | undefined
  // counts Map 也放 globalThis:zai 服走 dist/.js,claude.ts 走 opencc-core.mjs
  // bundle,两套 module 的 module-local Map 不共享 — 用 globalThis 让它们
  // 看到同一份。
  // eslint-disable-next-line no-var
  var __zaiApiCounts: Map<string, number> | undefined
}

function getCounts(): Map<string, number> {
  if (!globalThis.__zaiApiCounts) {
    globalThis.__zaiApiCounts = new Map<string, number>()
  }
  return globalThis.__zaiApiCounts
}

/**
 * zai 服在每次 queryModel 出口(看到 Anthropic SDK message_delta.usage)
 * 同步写最近一次 API 调用的 usage。runtime.done emit 时读出,推给前端
 * store 显示"当前上下文大小"。
 *
 * 存 globalThis 而非 module-level:与 setCurrentApiCountSession 同样的
 * 简单性考虑(zai 服重启用 bun 跑 vendor .ts,module cache 与 global
 * state 一致)。
 */
export function setLastContextUsage(usage: {
  input: number
  cache_creation: number
  cache_read: number
  output: number
}): void {
  globalThis.__zaiApiCountLastUsage = usage
}

/**
 * 读最近一次 API 调用的 total context tokens(= input + cache_creation +
 * cache_read,等同 session 开始时塞进模型上下文的总字节数;不含 output)。
 * 无记录时返回 null(对应"该 session 还没推过 context"或 verifyApiKey 等
 * 早期调用)。
 */
export function getLastContextTokens(): number | null {
  const u = globalThis.__zaiApiCountLastUsage
  if (!u) return null
  return u.input + u.cache_creation + u.cache_read
}

/**
 * zai 服在每次 query 入口同步设当前 sessionId(在调 vendor query 之前)。
 * 同一调用栈内 recordApiCall 读到该值并 +1;不在 zai 服调用栈时(undefined)
 * 静默 no-op(对应 verifyApiKey / vendor 早期调用)。
 */
export function setCurrentApiCountSession(sessionId: string | null | undefined): void {
  globalThis.__zaiApiCountSession = sessionId ?? undefined
}

function getCurrentApiCountSession(): string | undefined {
  return globalThis.__zaiApiCountSession
}

/**
 * 记一次外层 queryModel / executeNonStreamingRequest 调用。
 * retry 不重复计(参见本文件头注释)。
 */
export function recordApiCall(): void {
  const sid = getCurrentApiCountSession()
  if (!sid) return
  const counts = getCounts()
  counts.set(sid, (counts.get(sid) ?? 0) + 1)
}

/**
 * 读取某 session 的累计 API 请求数;无该 session 记录时返回 0。
 * zai 服 runQueryLoop 在 emit runtime.done 时调用,把 total 推给前端。
 */
export function getApiCallCount(sessionId: string): number {
  return getCounts().get(sessionId) ?? 0
}

/**
 * 清空某 session 的计数(zai 服 session 终止时调,避免僵尸 session
 * 的计数被新 session 误读)。
 */
export function clearApiCallCount(sessionId: string): void {
  getCounts().delete(sessionId)
}

/** 测试 seam:清空全部计数,避免单测间互相污染。 */
export function __resetApiCallCountsForTests(): void {
  getCounts().clear()
  globalThis.__zaiApiCountSession = undefined
  globalThis.__zaiApiCountLastUsage = undefined
}
