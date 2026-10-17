import { describe, expect, it } from 'vitest'
import { translateSdkToRuntime } from '../../../src/compat/runtime/sdkEventAdapter.js'

const meta = { sessionId: 's1', turnIndex: 0, eventCounter: 0 }

describe('translateSdkToRuntime', () => {
  it('emits message_start + content_block_start(text) + content_block_delta(text_delta) + content_block_stop for assistant text', () => {
    const assistantMsg = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: null,
      },
    }
    const events = [...translateSdkToRuntime(assistantMsg, { ...meta, eventCounter: 1 })]
    const types = events.map((event) => event.type)
    expect(types).toContain('message_start')
    expect(types).toContain('content_block_start')
    expect(types).toContain('content_block_delta')
    expect(types).toContain('content_block_stop')
    const delta = events.find((event) => event.type === 'content_block_delta')
    expect(delta?.delta).toMatchObject({ type: 'text_delta', text: 'hello' })
  })

  it('emits content_block_start(tool_use) for assistant tool_use blocks', () => {
    const msg = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        model: 'm',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
        ],
        stop_reason: 'tool_use',
      },
    }
    const events = [...translateSdkToRuntime(msg, { ...meta, eventCounter: 1 })]
    const start = events.find((event) => event.type === 'content_block_start')
    expect(start?.content_block).toMatchObject({ type: 'tool_use', name: 'Bash' })
  })

  it('emits message_delta + message_stop on ResultMessage', () => {
    const result = {
      type: 'result',
      subtype: 'success',
      duration_ms: 100,
      total_cost_usd: 0.001,
      result: 'final',
    }
    const events = [...translateSdkToRuntime(result, { ...meta, eventCounter: 1 })]
    expect(events.map((event) => event.type)).toContain('message_delta')
    expect(events.map((event) => event.type)).toContain('message_stop')
  })

  it('passes through system/init (carries tools list, required by SDK consumers)', () => {
    // opencc vendor's QueryEngine yields system/init as the FIRST
    // SDKMessage of every query — it carries the model-visible tools
    // list (built-ins + mcp__*) plus session/cwd metadata. The SDK
    // contract requires consumers to receive it; zai's runtime tests
    // (openccRuntime-query.test.ts) and remote SDK clients depend on
    // it. Filtering it here broke both `exposes MCP tools to the model`
    // regression tests.
    const sys = { type: 'system', subtype: 'init', cwd: '/x', tools: ['Bash'] }
    const events = [...translateSdkToRuntime(sys, meta)]
    expect(events.map((e) => e.type)).toEqual(['system'])
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init', tools: ['Bash'] })
  })

  it('passes through system/compact_boundary (transcript truncation marker)', () => {
    // QueryEngine emits system/compact_boundary when the autocompact
    // loop truncates the transcript — session readers rely on this
    // marker to know where to slice.
    const sys = { type: 'system', subtype: 'compact_boundary', uuid: 'u1', compact_metadata: {} }
    const events = [...translateSdkToRuntime(sys, meta)]
    expect(events.map((e) => e.type)).toEqual(['system'])
  })

  it('filters other system subtypes (local_command etc.)', () => {
    // Anything else with type:'system' is dropped — QueryEngine
    // converts local_command output to assistant messages BEFORE
    // yielding (QueryEngine.ts:629), so this branch is defensive.
    const sys = { type: 'system', subtype: 'local_command', content: '<local-command-stdout>ls</local-command-stdout>' }
    const events = [...translateSdkToRuntime(sys, meta)]
    expect(events).toEqual([])
  })

  it('attaches RuntimeEvent meta (eventId, sessionId, ts, turnIndex) to each event', () => {
    const msg = {
      type: 'assistant',
      message: { id: 'm', model: 'm', content: [{ type: 'text', text: 'x' }], stop_reason: null },
    }
    // (zai patch 2026-08-30 review update): set lastStreamedTurnMessageId
    // to this message's id to simulate "stream_event-wrapped message_start
    // already bumped for this turn". This is the production case for
    // streaming turns — wrapper path must NOT double-bump. Without
    // this guard the wrapper would bump turnIndex from 0 to 1, which
    // would mis-trigger "new turn" detection downstream.
    //
    // The id must MATCH, not merely be present: the runtime loop bumps
    // eventCounter between every SDKMessage, so a counter-based key can
    // never match in production (see the dedicated regression test below).
    const events = [...translateSdkToRuntime(msg, { ...meta, eventCounter: 5, lastStreamedTurnMessageId: 'm' })]
    for (const event of events) {
      expect(event.eventId).toMatch(/^evt-5(\.\d+)?$/)
      expect(event.sessionId).toBe('s1')
      expect(event.turnIndex).toBe(0)
      expect(typeof event.ts).toBe('number')
    }
    // All emitted events from one message must have distinct eventIds
    // (per-event uniqueness, required by SSE Last-Event-ID / dedupe).
    const ids = events.map((event) => event.eventId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('unpacks stream_event SDKMessage into Anthropic primitives (not pass-through)', () => {
    // vendor query() emits `{ type: 'stream_event', event: <raw anthropic event> }`
    // for every SDKMessage that wraps an upstream SSE event. The translator
    // must extract `event` and re-emit the raw event type, NOT yield a
    // RuntimeEvent with type:'stream_event' (which routes/agent.ts does not
    // understand and which breaks text_delta streaming UX).
    const streamEventTextDelta = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      },
      parent_tool_use_id: null,
    }
    const events = [...translateSdkToRuntime(streamEventTextDelta, { ...meta, eventCounter: 1 })]
    expect(events.map((e) => e.type)).toEqual(['content_block_delta'])
    const [ev] = events
    expect(ev?.delta).toMatchObject({ type: 'text_delta', text: 'hi' })
    expect((ev as any).type).not.toBe('stream_event')
  })

  it('unpacks stream_event message_start / message_stop / content_block_start primitives', () => {
    const streamStart = {
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg_x', model: 'm', role: 'assistant' } },
    }
    const streamBlockStart = {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    }
    const streamStop = {
      type: 'stream_event',
      event: { type: 'message_stop', 'amazon-bedrock-invocationMetrics': undefined },
    }
    const out = [
      ...translateSdkToRuntime(streamStart, { ...meta, eventCounter: 1 }),
      ...translateSdkToRuntime(streamBlockStart, { ...meta, eventCounter: 1 }),
      ...translateSdkToRuntime(streamStop, { ...meta, eventCounter: 1 }),
    ]
    expect(out.map((e) => e.type)).toEqual(['message_start', 'content_block_start', 'message_stop'])
  })

  it('records tool_use_id → name mapping from stream_event content_block_start(tool_use)', () => {
    // Subsequent user/tool_result message (yielded later by runTools) will
    // need to look up the tool name via toolNameByUseId. The stream_event
    // path must populate it the same way the assistant-message path does.
    const toolNameByUseId = new Map<string, string>()
    const streamBlockStart = {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_stream_1', name: 'Bash' },
      },
    }
    const events = [
      ...translateSdkToRuntime(streamBlockStart, { ...meta, eventCounter: 1, toolNameByUseId }),
    ]
    expect(events.map((e) => e.type)).toContain('content_block_start')
    expect(toolNameByUseId.get('tu_stream_1')).toBe('Bash')
  })

  it('suppresses stream_event message_stop while tools are pending', () => {
    // Mirror existing line 76-78 logic for the format-(b) pass-through branch:
    // if there are pending tool_use blocks, defer message_stop until after
    // the tool_result user message has cleared the map. Apply the same rule
    // to stream_event-wrapped message_stops so vendor and adapter streams
    // behave identically.
    const toolNameByUseId = new Map<string, string>([['tu_pending', 'Bash']])
    const streamStop = {
      type: 'stream_event',
      event: { type: 'message_stop' },
    }
    const events = [...translateSdkToRuntime(streamStop, { ...meta, eventCounter: 1, toolNameByUseId })]
    // message_stop is suppressed — generator should yield nothing.
    expect(events).toEqual([])
    toolNameByUseId.delete('tu_pending')
    const events2 = [...translateSdkToRuntime(streamStop, { ...meta, eventCounter: 2, toolNameByUseId })]
    expect(events2.map((e) => e.type)).toEqual(['message_stop'])
  })

  it('translates thinking content blocks to thinking_delta + content_block{type:"thinking"}', () => {
    const msg = {
      type: 'assistant',
      message: {
        id: 'msg_2',
        model: 'm',
        content: [{ type: 'thinking', thinking: 'reasoning about the problem' }],
        stop_reason: null,
      },
    }
    const events = [...translateSdkToRuntime(msg, { ...meta, eventCounter: 1 })]
    const start = events.find((event) => event.type === 'content_block_start')
    expect(start?.content_block).toMatchObject({ type: 'thinking', thinking: '' })
    const delta = events.find((event) => event.type === 'content_block_delta')
    expect(delta?.delta).toMatchObject({
      type: 'thinking_delta',
      thinking: 'reasoning about the problem',
    })
    expect(events.map((event) => event.type)).toContain('content_block_stop')
  })

  it('skips re-emitting content_block_* in terminal assistant message for blocks already streamed via stream_event', () => {
    // vendor query() emits BOTH the raw Anthropic SSE events (wrapped as
    // `stream_event`) AND the terminal `assistant` message with the
    // same content blocks. Re-emitting them in the assistant-message
    // path produces two `runtime.tool_call` SSE events for the same
    // toolUseId (→ two Bash cards in the zai UI). Track streamed
    // indices from path A and skip them in path B.
    const streamedBlockIndices = new Set<number>()
    const streamSequence = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_x', model: 'm', role: 'assistant' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_stream_1', name: 'Bash' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } },
    ]
    const assistantMsg = {
      type: 'assistant',
      message: {
        id: 'msg_x',
        model: 'm',
        content: [{ type: 'tool_use', id: 'tu_stream_1', name: 'Bash', input: { command: 'ls' } }],
        stop_reason: 'tool_use',
      },
    }
    const metaWithIndex = {
      ...meta,
      eventCounter: 7,
      toolNameByUseId: new Map<string, string>(),
      streamedBlockIndices,
    }
    const streamedEvents = streamSequence.flatMap((m) =>
      [...translateSdkToRuntime(m, metaWithIndex)],
    )
    // stream_event path emitted the block — its index is now tracked.
    expect(streamedBlockIndices.has(0)).toBe(true)
    const contentBlockStartTypes = streamedEvents
      .map((e) => e.type)
      .filter((t) => t === 'content_block_start')
    expect(contentBlockStartTypes).toHaveLength(1)

    // Terminal assistant message: the block at index 0 was already
    // streamed, so it must NOT re-emit content_block_start/delta/stop.
    const terminalEvents = [...translateSdkToRuntime(assistantMsg, metaWithIndex)]
    const terminalTypes = terminalEvents.map((e) => e.type)
    expect(terminalTypes).toContain('message_start')
    expect(terminalTypes).toContain('message_delta')
    expect(terminalTypes).not.toContain('content_block_start')
    expect(terminalTypes).not.toContain('content_block_delta')
    expect(terminalTypes).not.toContain('content_block_stop')
  })

  it('does not double-bump turnIndex when eventCounter advances between stream_event and terminal assistant', () => {
    // Production fidelity: createOpenccRuntime-impl.ts increments
    // `adapterMeta.eventCounter` AFTER every translateSdkToRuntime call,
    // so by the time the terminal `assistant` SDKMessage is translated,
    // eventCounter has already moved past the value recorded at
    // stream_event message_start. The old guard
    // (`lastStreamedMessageStartCounter !== eventCounter`) therefore
    // compared two values that can never be equal in production and
    // bumped turnIndex a SECOND time on every streaming turn.
    //
    // Symptom: the frontend's useAgentStore.runtime.started branch keys
    // "new turn" off strict-greater-than turnIndex, so the phantom bump
    // opens a second empty bubble between the streamed and the
    // synthesized blocks.
    const liveMeta = {
      sessionId: 's1',
      turnIndex: 0,
      eventCounter: 7,
      toolNameByUseId: new Map<string, string>(),
      streamedBlockIndices: new Set<number>(),
    }
    const streamSequence = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_x', model: 'm', role: 'assistant' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
    ]
    const assistantMsg = {
      type: 'assistant',
      message: { id: 'msg_x', model: 'm', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' },
    }

    // Stream the sequence exactly the way the runtime loop does: translate
    // one message, then bump eventCounter.
    for (const m of streamSequence) {
      ;[...translateSdkToRuntime(m, liveMeta)]
      liveMeta.eventCounter += 1
    }
    // message_start bumped turnIndex 0 → 1.
    expect(liveMeta.turnIndex).toBe(1)

    const terminalEvents = [...translateSdkToRuntime(assistantMsg, liveMeta)]

    // The terminal assistant message belongs to the SAME turn (msg_x):
    // stream_event already bumped it, so turnIndex must stay 1 across
    // every event the terminal message emits.
    expect(terminalEvents.length).toBeGreaterThan(0)
    for (const event of terminalEvents) {
      expect(event.turnIndex).toBe(1)
    }
    expect(liveMeta.turnIndex).toBe(1)
  })

  it('still bumps turnIndex on the terminal assistant message when no stream_event preceded it', () => {
    // The latent gap the guard exists for: vendor replays an assistant
    // message WITHOUT wrapping its message_start in stream_event
    // (non-streaming playback). No bump happened yet, so the terminal
    // path must bump 0 → 1 on its own.
    const freshMeta = {
      sessionId: 's1',
      turnIndex: 0,
      eventCounter: 3,
      toolNameByUseId: new Map<string, string>(),
      streamedBlockIndices: new Set<number>(),
    }
    const assistantMsg = {
      type: 'assistant',
      message: { id: 'msg_solo', model: 'm', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' },
    }
    const events = [...translateSdkToRuntime(assistantMsg, freshMeta)]
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event.turnIndex).toBe(1)
    }
  })

  it('bumps turnIndex again for a SECOND turn streamed in the same query', () => {
    // One query() bridges many LLM turns (main → agent dispatch → main
    // close → sub-agent → new turn), so turnIndex must keep advancing
    // across turns while each turn's stream_event+terminal pair stays
    // balanced at one bump.
    const liveMeta = {
      sessionId: 's1',
      turnIndex: 0,
      eventCounter: 0,
      toolNameByUseId: new Map<string, string>(),
      streamedBlockIndices: new Set<number>(),
    }
    const streamOneTurn = (msgId: string) => {
      for (const m of [
        { type: 'stream_event', event: { type: 'message_start', message: { id: msgId, model: 'm', role: 'assistant' } } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      ]) {
        ;[...translateSdkToRuntime(m, liveMeta)]
        liveMeta.eventCounter += 1
      }
      ;[...translateSdkToRuntime(
        { type: 'assistant', message: { id: msgId, model: 'm', content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' } },
        liveMeta,
      )]
      liveMeta.eventCounter += 1
    }

    streamOneTurn('msg_a')
    expect(liveMeta.turnIndex).toBe(1)
    streamOneTurn('msg_b')
    expect(liveMeta.turnIndex).toBe(2)
    streamOneTurn('msg_c')
    expect(liveMeta.turnIndex).toBe(3)
  })

  it('resets streamedBlockIndices on each stream_event message_start', () => {
    // Without reset, indices from a previous assistant message would
    // falsely skip blocks in the next message.
    const streamedBlockIndices = new Set<number>([0, 1, 2])
    const newMessageStart = {
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg_2', model: 'm', role: 'assistant' } },
    }
    const events = [
      ...translateSdkToRuntime(newMessageStart, { ...meta, eventCounter: 1, streamedBlockIndices }),
    ]
    expect(streamedBlockIndices.size).toBe(0)
    expect(events.map((e) => e.type)).toContain('message_start')
  })
})
