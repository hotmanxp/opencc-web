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

  it('skips SystemMessage (init / local_command) — zai handles those separately', () => {
    const sys = { type: 'system', subtype: 'init', cwd: '/x', tools: [] }
    const events = [...translateSdkToRuntime(sys, meta)]
    expect(events).toEqual([])
  })

  it('attaches RuntimeEvent meta (eventId, sessionId, ts, turnIndex) to each event', () => {
    const msg = {
      type: 'assistant',
      message: { id: 'm', model: 'm', content: [{ type: 'text', text: 'x' }], stop_reason: null },
    }
    const events = [...translateSdkToRuntime(msg, { ...meta, eventCounter: 5 })]
    for (const event of events) {
      expect(event.eventId).toBe('evt-5')
      expect(event.sessionId).toBe('s1')
      expect(event.turnIndex).toBe(0)
      expect(typeof event.ts).toBe('number')
    }
  })
})
