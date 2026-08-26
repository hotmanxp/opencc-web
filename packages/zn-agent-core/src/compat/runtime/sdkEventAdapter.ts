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
  /**
   * Map of tool_use_id → tool name. Populated by the bridge when it
   * sees a content_block_start with type=tool_use, consumed when a
   * subsequent user message yields a matching tool_result block.
   * opencc's tool_result block does not repeat the tool name, so the
   * bridge has to remember the mapping across events.
   */
  toolNameByUseId?: Map<string, string>
  /**
   * Indices of content blocks that have already been streamed via the
   * `stream_event` wrapper path. vendor `query()` emits BOTH the raw
   * Anthropic SSE events (wrapped as `stream_event`) AND the terminal
   * `assistant` message with the same content blocks. The
   * assistant-message path re-emits each block as fresh
   * content_block_start/delta/stop, which would double-render at the
   * SSE consumer (e.g. two `runtime.tool_call` events for the same
   * toolUseId → two `Bash` cards in the zai UI). Skip re-emission
   * in the assistant-message path when the index is already in this
   * set.
   *
   * Reset on each `stream_event message_start` so the set is scoped
   * per assistant message.
   */
  streamedBlockIndices?: Set<number>
}

export function* translateSdkToRuntime(
  openccMessage: unknown,
  meta: SdkEventMeta,
): Generator<RuntimeEvent> {
  const m = openccMessage as {
    type?: string
    subtype?: string
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
  // 系统事件(system/init / system/compact_boundary)必须透传 —— init 事件
  // 携带模型可见的 tools 列表(mcp__* / 内建),SDK 客户端与 zai
  // server 都需要消费它;compact_boundary 标记 transcript 截断点,session
  // 读取端需要识别。opencc vendor QueryEngine 把这两个 SDKMessage 直接
  // yield 给消费者,adapter 不应吞掉。
  if (m.type === 'system' && m.subtype !== 'init' && m.subtype !== 'compact_boundary') return

  // opencc's vendor query() emits a `{ type: 'stream_event', event: <raw
  // Anthropic SSE event> }` SDKMessage for every upstream token that arrives
  // before the assistant-message is finalized. Without unpacking, this branch
  // would fall through to the format-(b) catch-all below and yield a
  // RuntimeEvent with `type:'stream_event'` — which routes/agent.ts does not
  // understand, killing the live text_delta / thinking_delta streaming UX.
  // Unwrap `m.event` and re-emit the raw event type so the downstream SSE
  // translator sees the same primitives as a non-streaming path.
  if (m.type === 'stream_event') {
    const raw = (m as any).event as
      | {
          type?: string
          index?: number
          content_block?: { type?: string; id?: string; name?: string }
        }
      | undefined
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return
    // Mirror the format-(b) message_stop pending-tool suppression (the
    // comment block on lines 67-75) so an early stream_event-wrapped
    // message_stop doesn't freeze opencc's tool execution on the consumer
    // side. Same rule applies regardless of how message_stop arrived.
    if (
      raw.type === 'message_stop' &&
      meta.toolNameByUseId &&
      meta.toolNameByUseId.size > 0
    ) {
      return
    }
    // Reset per-message streaming index set on message_start so the
    // terminal `assistant` message can skip blocks already streamed via
    // this path. Without this reset, indices from a previous assistant
    // message would falsely skip the next message's blocks.
    if (raw.type === 'message_start' && meta.streamedBlockIndices) {
      meta.streamedBlockIndices.clear()
    }
    // Track which block indices have been streamed via the stream_event
    // path so the terminal `assistant` message can skip re-emitting
    // them. Without this, each tool_use produces two `runtime.tool_call`
    // SSE events (one from the streamed content_block_stop, one from the
    // re-synthesized one) and the zai UI renders two Bash cards for
    // the same toolUseId.
    if (
      raw.type === 'content_block_start' &&
      meta.streamedBlockIndices &&
      typeof raw.index === 'number'
    ) {
      meta.streamedBlockIndices.add(raw.index)
    }
    // Mirror the content_block_start(tool_use) mapping so a later
    // user/tool_result message can attach the tool name to its
    // tool_use:done event (see the match-up logic at lines 161-189).
    if (
      raw.type === 'content_block_start' &&
      meta.toolNameByUseId &&
      raw.content_block?.type === 'tool_use' &&
      raw.content_block.id &&
      raw.content_block.name
    ) {
      meta.toolNameByUseId.set(raw.content_block.id, raw.content_block.name)
    }
    yield makeEvent(raw.type, meta, 0, raw as unknown as Record<string, unknown>)
    return
  }

  // opencc's `query()` may emit a terminal `result` SDKMessage after the
  // assistant message's message_stop (e.g. when the run produced a final
  // synthetic summary, or when the loop completes with a structured
  // envelope — duration_ms / total_cost_usd). The format-(b) catch-all
  // below would yield a `result`-typed RuntimeEvent, but zai's SSE
  // translator (routes/agent.ts::translateRuntimeEvents) only recognises
  // Anthropic primitives — anything else is dropped on the floor.
  // Synthesize a final `message_delta` + `message_stop` pair so the
  // consumer sees a normal end-of-turn signal: routes/agent.ts maps
  // message_stop → runtime.done, which closes the for-await loop.
  //
  // Mirror the format-(b) message_stop suppression (lines 156-158): if
  // there are pending tool_use blocks, hold back — opencc will issue
  // another assistant turn after the tool results land, and that turn's
  // own message_stop is the one we want to propagate. (The test
  // sdkEventAdapter.test.ts asserts the non-pending path.)
  if (m.type === 'result') {
    yield makeEvent('message_delta', meta, 0, {
      delta: { stop_reason: 'end_turn' },
    })
    if (meta.toolNameByUseId && meta.toolNameByUseId.size > 0) return
    yield makeEvent('message_stop', meta, 1, {})
    return
  }

  if (m.type !== 'assistant' && m.type !== 'user') {
    // Format (b): Anthropic primitive (message_start, content_block_*, etc).
    // Pass through with zai meta fields attached. For tool_use
    // content_block_start, also record the toolUseId → tool name
    // mapping so we can attach the name to the later tool_result.
    //
    // CRITICAL: don't yield message_stop if there are pending
    // tool_use blocks. routes/agent.ts::translateRuntimeEvents
    // translates message_stop → runtime.done, which the consumer's
    // outer for-await breaks on, which calls .return() on this
    // generator and freezes opencc's tool execution. With the
    // suppression, opencc continues to process the tool, the
    // user message with tool_result comes through (handled by the
    // user message branch below), and the LLM's follow-up turn
    // produces the *real* final message_stop that we let through.
    if (m.type === 'message_stop' && meta.toolNameByUseId && meta.toolNameByUseId.size > 0) {
      return
    }
    if (m.type === 'content_block_start' && meta.toolNameByUseId) {
      const cb = (m as any).content_block as
        | { type?: string; id?: string; name?: string }
        | undefined
      if (cb?.type === 'tool_use' && cb.id && cb.name) {
        meta.toolNameByUseId.set(cb.id, cb.name)
      }
    }
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
      // Skip blocks that were already streamed via the stream_event
      // wrapper path. vendor `query()` emits the raw Anthropic SSE
      // events as `stream_event` wrappers AND the terminal `assistant`
      // message with the same content blocks; re-emitting them here
      // would double-render at the SSE consumer (e.g. two
      // `runtime.tool_call` events for the same toolUseId → two Bash
      // cards in the zai UI). message_start / message_delta still
      // emit because those are needed for the consumer's
      // translateRuntimeEvents to finalize the turn.
      if (meta.streamedBlockIndices?.has(blockIndex)) {
        blockIndex++
        continue
      }
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
        // Record the tool_use_id → name mapping so the matching
        // tool_result (yielded later as a `user` message) can include
        // the name. opencc's tool_result block doesn't repeat it.
        if (meta.toolNameByUseId && block.id && block.name) {
          meta.toolNameByUseId.set(block.id, block.name)
          if (process.env.ZAI_DEBUG === '1') console.log('[adapter] recorded tool name', block.name, 'for', block.id, 'map size now', meta.toolNameByUseId.size)
        }
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
      // The opencc `tool_result` block only carries `tool_use_id` — it
      // doesn't repeat the tool name. The bridge tracks the name when
      // it sees the matching tool_use content_block_start, so we can
      // look it up here. If we don't, translateRuntimeEvents in
      // routes/agent.ts will default `toolName` to "unknown" (its
      // pendingToolName is cleared after content_block_stop emits
      // the runtime.tool_call) and the frontend's upsertToolCall
      // will overwrite the stored "Bash" with "unknown".
      const toolName = meta.toolNameByUseId?.get(block.tool_use_id ?? '')
      yield emit('tool_use:done', {
        id: block.tool_use_id,
        toolUseId: block.tool_use_id,
        ...(toolName ? { name: toolName } : {}),
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
