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

  // opencc's query() can yield events in two shapes:
  // (a) opencc Message wrapper: { type: 'assistant'|'user'|'system', message: { role, content } }
  //     — older format that needs unwrapping to Anthropic primitives
  // (b) Anthropic-style primitives: { type: 'message_start'|'content_block_start'|... }
  //     — already in zai's RuntimeEvent shape, just attach meta and pass through
  //
  // Detect which format and handle accordingly.
  if (m.type === 'system') return

  if (m.type !== 'assistant' && m.type !== 'user') {
    // Format (b): Anthropic primitive (message_start, content_block_*, etc).
    // Pass through with zai meta fields attached.
    yield makeEvent(String(m.type), meta, 0, m as Record<string, unknown>)
    return
  }

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

  // User messages with tool_result content blocks: opencc yields these
  // from runTools() to signal that a tool call has completed. Without
  // translating them to tool_use:done, the frontend never sees a
  // runtime.tool_result event and the tool block stays as "工具调用中..."
  // (calling) forever — even after the LLM's follow-up turn streams
  // in. routes/agent.ts::translateRuntimeEvents handles tool_use:done
  // → runtime.tool_result, so emit one per tool_result block.
  if (m.type === 'user' && m.message) {
    const blocks = (m.message.content ?? []) as Array<{
      type?: string
      tool_use_id?: string
      content?: unknown
      is_error?: boolean
    }>
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue
      yield emit('tool_use:done', {
        id: block.tool_use_id,
        toolUseId: block.tool_use_id,
        output: block.content,
        isError: block.is_error === true,
      })
    }
    return
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
