/**
 * streamAdapter — RuntimeEvent helpers used by openccAdapter.
 *
 * Ported from `@zn-ai/zai-agent-core/src/runtime/streamAdapter.ts`. Provides:
 *  - wrapWithZaiMeta: enriches an opencc stream with zai meta fields
 *  - toRuntimeErrorEvent: convert any thrown value into a runtime.error event
 *  - toAbortedEvent: emit a runtime.aborted event
 *  - classifyError: best-effort ErrorCategory from error.message text
 *
 * Uses module-local eventCounter so multiple consumers in the same process
 * don't collide on eventId. Mirrors the upstream implementation.
 */

import type { RuntimeEvent, RuntimeErrorEvent, RuntimeAbortedEvent } from './events.js'

let eventCounter = 0

export async function* wrapWithZaiMeta(
  openccStream: AsyncGenerator<Record<string, unknown>>,
  ctx: { sessionId: string; sessionStartTs: number },
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
      type: String((event as any).type ?? ''),
    } as RuntimeEvent
    // Track turnIndex from content_block_start tool_use
    if (
      (event as any).type === 'content_block_start' &&
      (event as any).content_block?.type === 'tool_use'
    ) {
      turnIndex++
    }
    yield enriched
  }
  // Terminal runtime.done is yielded by queryEngine after all turns.
  // Don't yield per-stream to avoid early break in upstream for-await.
}

export function toRuntimeErrorEvent(
  err: unknown,
  ctx: { sessionId: string; turnIndex: number },
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
      recoverable:
        category === 'tool_execution' ||
        category === 'mcp_server' ||
        category === 'transcript_io',
      code: (err as any)?.code,
    },
  }
}

export function toAbortedEvent(
  ctx: { sessionId: string; turnIndex: number },
  reason?: string,
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

export function classifyError(err: Error): RuntimeErrorEvent['error']['category'] {
  const msg = err.message.toLowerCase()
  // 529 / overloaded → sub-category, triggers BackgroundRuntime auto-retry
  if (msg.includes('529') || msg.includes('overloaded_error')) {
    return 'llm_provider_overloaded'
  }
  // 401/403 → auth sub-category
  if (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('unauthorized') ||
    msg.includes('auth')
  ) {
    return 'llm_provider_auth'
  }
  // 429 rate limit → sub-category
  if (msg.includes('429') || msg.includes('rate limit')) {
    return 'llm_provider_rate_limit'
  }
  // 5xx / network errors → server sub-category
  if (
    msg.includes('5') ||
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset')
  ) {
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
