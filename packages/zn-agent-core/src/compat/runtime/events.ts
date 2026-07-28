/**
 * RuntimeEvent contract — ported verbatim from
 * `@zn-ai/zai-agent-core/src/runtime/events.ts` as a compat shim.
 *
 * The new package does not yet have its own runtime event schema (opencc's
 * internal RuntimeEvent lives elsewhere and doesn't match zai's surface).
 * Until Batch 2/3 lands the unified event types, this verbatim port gives
 * background/runtime shims a stable ErrorCategory + RuntimeEvent they can
 * type against without depending on opencc's internal types.
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
