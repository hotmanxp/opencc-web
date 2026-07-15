import { randomUUID } from 'crypto'
import type { RuntimeEvent, RuntimeErrorEvent, ErrorCategory, RuntimeDoneEvent, RuntimeAbortedEvent } from './events.js'

export type StreamEvent = {
  type: string
  [key: string]: unknown
}

let eventCounter = 0

export async function* wrapWithZaiMeta(
  openccStream: AsyncGenerator<StreamEvent>,
  ctx: { sessionId: string; sessionStartTs: number }
): AsyncGenerator<RuntimeEvent> {
  let turnIndex = 0
  for await (const event of openccStream) {
    eventCounter++
    const enriched: RuntimeEvent = {
      ...event,
      eventId: `evt-${eventCounter}`,
      sessionId: ctx.sessionId,
      ts: Date.now(),
      turnIndex,
      type: event.type,
    }
    // Track turnIndex from content_block_start tool_use
    if (event.type === 'content_block_start' && (event as any).content_block?.type === 'tool_use') {
      turnIndex++
    }
    yield enriched
  }
  // 末端的 runtime.done 由 queryEngine 在 turn 全部结束后统一 yield.
  // 不要再在每段 wrap 内重复 yield — 会让上游 for-await 提前 break,
  // 导致 queryEngine 永远走不到 appendAssistantMessage / 后续 turn.
}

export function toRuntimeErrorEvent(
  err: unknown,
  ctx: { sessionId: string; turnIndex: number }
): RuntimeErrorEvent {
  eventCounter++
  const error = err instanceof Error ? err : new Error(String(err))
  const category = classifyError(error)
  return {
    eventId: `evt-${eventCounter}`,
    sessionId: ctx.sessionId,
    ts: Date.now(),
    turnIndex: ctx.turnIndex,
    type: 'runtime.error',
    error: {
      category,
      message: error.message,
      detail: error.stack,
      recoverable: category === 'tool_execution' || category === 'mcp_server' || category === 'transcript_io',
      code: (err as any)?.code,
    },
  }
}

export function toAbortedEvent(
  ctx: { sessionId: string; turnIndex: number },
  reason?: string
): RuntimeAbortedEvent {
  eventCounter++
  return {
    eventId: `evt-${eventCounter}`,
    sessionId: ctx.sessionId,
    ts: Date.now(),
    turnIndex: ctx.turnIndex,
    type: 'runtime.aborted',
    reason,
  }
}

function classifyError(err: Error): ErrorCategory {
  const msg = err.message.toLowerCase()
  // 529 / overloaded → 子分类, 触发 BackgroundRuntime 自动重试.
  if (msg.includes('529') || msg.includes('overloaded_error')) {
    return 'llm_provider_overloaded'
  }
  // 401/403 → auth 子分类（区别于其他 4xx，避免被 retry 当 5xx 重试）.
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('auth')) {
    return 'llm_provider_auth'
  }
  // 429 rate limit → 子分类；quota-exhausted 仍由 BackgroundRuntime.catch 路径
  // 通过 classifyRetryableError 区分, 此处只做粗粒度 fallback.
  if (msg.includes('429') || msg.includes('rate limit')) {
    return 'llm_provider_rate_limit'
  }
  // 5xx / 网络错误 → server 子分类.
  if (msg.includes('5') || msg.includes('timeout') || msg.includes('fetch failed') || msg.includes('econnrefused') || msg.includes('econnreset')) {
    return 'llm_provider_server'
  }
  if (msg.includes('abort')) {
    return 'aborted'
  }
  if (msg.includes('context window') || msg.includes('prompt too long')) {
    return 'context_window'
  }
  if (msg.includes('mcp') || msg.includes('server')) {
    return 'mcp_server'
  }
  if (msg.includes('skill')) {
    return 'skill_load'
  }
  if (msg.includes('transcript') || msg.includes('file') || msg.includes('lock')) {
    return 'transcript_io'
  }
  return 'internal'
}
