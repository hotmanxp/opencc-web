import { describe, expect, it } from 'vitest'
import { translateSdkToRuntime } from '../../../src/compat/runtime/sdkEventAdapter.js'

describe('translateSdkToRuntime', () => {
  it('translates an opencc SystemMessage into runtime.system', () => {
    const out = [...translateSdkToRuntime(
      { type: 'system', subtype: 'init' },
      { sessionId: 'sess-1', turnIndex: 0, eventCounter: 0 },
    )]
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('runtime.system')
    expect((out[0] as any).sessionId).toBe('sess-1')
    expect((out[0] as any).turnIndex).toBe(0)
    expect(typeof (out[0] as any).eventId).toBe('string')
  })

  it('translates an opencc AssistantMessage into message_start + message_stop', () => {
    const out = [...translateSdkToRuntime(
      { type: 'assistant', message: { id: 'msg_1', model: 'claude-x', content: [] } },
      { sessionId: 'sess-1', turnIndex: 0, eventCounter: 0 },
    )]
    // message_start + message_stop; the full content block walk is a
    // future commit (opencc AssistantMessage → Anthropic primitives).
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out[0].type).toBe('message_start')
    expect((out[0] as any).message.id).toBe('msg_1')
    expect(out[out.length - 1].type).toBe('message_stop')
  })

  it('translates an opencc ResultMessage into runtime.done', () => {
    const out = [...translateSdkToRuntime(
      { type: 'result', durationMs: 1234, totalCostUsd: 0.001 },
      { sessionId: 'sess-1', turnIndex: 1, eventCounter: 0 },
    )]
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('runtime.done')
    expect((out[0] as any).turnIndex).toBe(1)
  })

  it('falls through unknown message types to runtime.system', () => {
    const out = [...translateSdkToRuntime(
      { type: 'totally_new_variant', payload: 'x' },
      { sessionId: 'sess-1', turnIndex: 0, eventCounter: 0 },
    )]
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('runtime.system')
    expect((out[0] as any).payload.kind).toBe('unknown')
  })

  it('emits monotonically-increasing eventId counters', () => {
    const out = [...translateSdkToRuntime(
      { type: 'result', durationMs: 1 },
      { sessionId: 's', turnIndex: 0, eventCounter: 0 },
    )]
    const ids = out.map((e) => (e as any).eventId)
    expect(ids).toEqual(ids.slice().sort()) // string sort matches counter
    expect(ids[0]).toMatch(/^evt-1$/)
  })
})