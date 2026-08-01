/**
 * RuntimeEvent contract.
 *
 * The discriminated union `RuntimeEvent` plus the `ErrorCategory` taxonomy
 * that the runtime, background subsystem, and SSE translator all type
 * against. Every consumer — `openccAdapter`, `wrapWithZaiMeta`,
 * `routes/agent.ts` `translateRuntimeEvents`, and the BackgroundRuntime
 * event mapper — produces values matching this shape so the same event
 * stream can flow through agent prompts and background tasks without
 * per-call site adaptation.
 *
 * The `ErrorCategory` union is split (overloaded / rate_limit / server /
 * auth) so retry policy in `BackgroundRuntime.runOne` can route 529
 * differently from 5xx; `llm_provider` is kept as a deprecated catch-all
 * for backward compatibility with older callers.
 */

export type ErrorCategory =
  /** DEPRECATED: 旧粗粒度分类，新代码请用下面 4 个子分类. */
  | 'llm_provider'
  /** 529 / `overloaded_error` — RETRYABLE. */
  | 'llm_provider_overloaded'
  /** 429 rate limit（不含 quota-exhausted）— RETRYABLE. */
  | 'llm_provider_rate_limit'
  /** 5xx / timeout / fetch failed / ECONNRESET — RETRYABLE. */
  | 'llm_provider_server'
  /** 401 / 403 — NOT retryable（依赖 token 刷新，由上层处理）. */
  | 'llm_provider_auth'
  | 'tool_execution'
  | 'permission_denied'
  | 'transcript_io'
  | 'context_window'
  | 'compaction_failure'
  | 'mcp_server'
  | 'skill_load'
  | 'internal'
  | 'aborted'

export type RuntimeEvent = {
  eventId: string
  sessionId: string
  ts: number
  turnIndex: number
  type: string
  [key: string]: unknown
}

export type RuntimeErrorEvent = RuntimeEvent & {
  type: 'runtime.error'
  error: {
    category: ErrorCategory
    message: string
    detail?: unknown
    recoverable: boolean
    code?: string
  }
}

export type RuntimeDoneEvent = RuntimeEvent & {
  type: 'runtime.done'
  text?: string
}

export type RuntimeAbortedEvent = RuntimeEvent & {
  type: 'runtime.aborted'
  reason?: string
}
