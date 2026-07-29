/**
 * SDKMessage → zai RuntimeEvent translator.
 *
 * opencc's `query()` (`opencc-src/query.ts`) emits a stream of `Message`s
 * (opencc's internal types). zai's `routes/agent.ts::translateRuntimeEvents`
 * consumes zai's `RuntimeEvent` shape (Anthropic content_block_* primitives).
 *
 * This adapter unwraps each opencc Message into 0..N Anthropic primitives
 * (message_start, content_block_*, message_delta, message_stop) and attaches
 * zai meta fields (eventId, sessionId, ts, turnIndex) so the downstream
 * SSE translator stays unchanged.
 */

import type { RuntimeEvent } from './events.js'

export interface SdkEventMeta {
  sessionId: string
  turnIndex: number
  eventCounter: number
}

export function* translateSdkToRuntime(
  openccMessage: unknown,
  meta: SdkEventMeta,
): Generator<RuntimeEvent> {
  const m = openccMessage as {
    type?: string
    message?: {
      id?: string
      model?: string
      content?: Array<{
        type?: string
        text?: string
        thinking?: string
        id?: string
        name?: string
        input?: unknown
      }>
      stop_reason?: string | null
    }
  }
  if (!m || typeof m !== 'object') return

  if (m.type === 'system') return

  // Per-call sequence so every emitted event from one message gets a
  // distinct eventId (evt-N, evt-N.1, evt-N.2, …). The SSE `Last-Event-ID`
  // dedupe path in routes/agent.ts relies on uniqueness.
  let seq = 0
  const emit = (type: string, extra: Record<string, unknown> = {}): RuntimeEvent =>
    makeEvent(type, meta, seq++, extra)

  if (m.type === 'assistant' && m.message) {
    yield emit('message_start', {
      message: { id: m.message.id, model: m.message.model, role: 'assistant' },
    })
    let blockIndex = 0
    for (const block of m.message.content ?? []) {
      if (block.type === 'text') {
        yield emit('content_block_start', {
          index: blockIndex,
          content_block: { type: 'text', text: '' },
        })
        yield emit('content_block_delta', {
          index: blockIndex,
          delta: { type: 'text_delta', text: block.text ?? '' },
        })
        yield emit('content_block_stop', { index: blockIndex })
      } else if (block.type === 'tool_use') {
        yield emit('content_block_start', {
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          },
        })
        yield emit('content_block_delta', {
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
        })
        yield emit('content_block_stop', { index: blockIndex })
      } else if (block.type === 'thinking') {
        yield emit('content_block_start', {
          index: blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        })
        yield emit('content_block_delta', {
          index: blockIndex,
          delta: { type: 'thinking_delta', thinking: block.thinking ?? '' },
        })
        yield emit('content_block_stop', { index: blockIndex })
      }
      blockIndex++
    }
    yield emit('message_delta', {
      delta: { stop_reason: m.message.stop_reason ?? 'end_turn' },
    })
    return
  }

  if (m.type === 'result') {
    yield emit('message_delta', { delta: { stop_reason: 'end_turn' } })
    yield emit('message_stop')
  }
}

function makeEvent(
  type: string,
  meta: SdkEventMeta,
  seq: number,
  extra: Record<string, unknown> = {},
): RuntimeEvent {
  const eventId = seq === 0 ? `evt-${meta.eventCounter}` : `evt-${meta.eventCounter}.${seq}`
  return {
    type,
    eventId,
    sessionId: meta.sessionId,
    turnIndex: meta.turnIndex,
    ts: Date.now(),
    ...extra,
  } as RuntimeEvent
}
