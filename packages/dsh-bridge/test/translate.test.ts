import { describe, it, expect } from 'vitest'
import {
  translateSessionEvent,
  ALL_SERVER_EVENT_GROUPS,
  listUnmappedEvents,
} from '../src/translate/sessionEvents.js'

/**
 * 事件翻译器单元测试 — B1a T1.3 核心子集覆盖。
 *
 * 验收：
 * - turn/start → runtime.started
 * - assistant/chunk(text-delta) → runtime.delta
 * - assistant/chunk(reasoning-delta) → runtime.thinking
 * - assistant/message → runtime.delta
 * - turn/end(completed) → runtime.done
 * - turn/end(error) → runtime.error
 * - turn/end(cancelled) → runtime.aborted
 * - tool/call → runtime.tool_call
 * - tool/result → runtime.tool_result
 * - user/message → ignorable (null)
 * - 未映射事件清单记录在 listUnmappedEvents()
 * - 11 组映射表初稿存在
 */

const ctx = { sessionId: 'sess-1', turnIndex: 0, seqBase: 0 }

describe('translateSessionEvent 核心子集', () => {
  it('turn/start → runtime.started', () => {
    const event = { type: 'turn/start', seq: 1, data: { turn: 1 } } as any
    const out = translateSessionEvent(event, ctx)
    expect(out).not.toBeNull()
    expect(out!.type).toBe('runtime.started')
    expect((out as any).sessionId).toBe('sess-1')
  })

  it('assistant/chunk (text-delta) → runtime.delta', () => {
    const event = {
      type: 'assistant/chunk',
      seq: 2,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hello' } },
    } as any
    const out = translateSessionEvent(event, ctx)
    expect(out!.type).toBe('runtime.delta')
    expect((out as any).delta).toBe('hello')
  })

  it('assistant/chunk (reasoning-delta) → runtime.thinking', () => {
    const event = {
      type: 'assistant/chunk',
      seq: 2,
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'thinking...' } },
    } as any
    const out = translateSessionEvent(event, ctx)
    expect(out!.type).toBe('runtime.thinking')
    expect((out as any).thinking).toBe('thinking...')
  })

  it('assistant/message → runtime.delta (累积文本)', () => {
    const event = {
      type: 'assistant/message',
      seq: 3,
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: 'final answer' }] },
      },
    } as any
    const out = translateSessionEvent(event, ctx)
    expect(out!.type).toBe('runtime.delta')
    expect((out as any).delta).toBe('final answer')
  })

  it('turn/end (completed) → runtime.done', () => {
    const event = {
      type: 'turn/end',
      seq: 4,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as any
    const out = translateSessionEvent(event, ctx)
    expect(out!.type).toBe('runtime.done')
  })

  it('turn/end (error) → runtime.error', () => {
    const event = {
      type: 'turn/end',
      seq: 4,
      data: { turn: 1, reason: { kind: 'error', error: { code: 'rate_limit', message: 'overloaded' } } },
    } as any
    const out = translateSessionEvent(event, ctx)
    expect(out!.type).toBe('runtime.error')
    expect((out as any).error.message).toBe('overloaded')
  })

  it('turn/end (cancelled) → runtime.aborted', () => {
    const event = {
      type: 'turn/end',
      seq: 4,
      data: { turn: 1, reason: { kind: 'cancelled' } },
    } as any
    const out = translateSessionEvent(event, ctx)
    expect(out!.type).toBe('runtime.aborted')
  })

  it('tool/call → runtime.tool_call', () => {
    const event = {
      type: 'tool/call',
      seq: 5,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'Bash',
        arguments: '{"cmd":"ls"}',
      },
    } as any
    const out = translateSessionEvent(event, ctx)
    expect(out!.type).toBe('runtime.tool_call')
    expect((out as any).toolUseId).toBe('call-1')
    expect((out as any).toolName).toBe('Bash')
    expect((out as any).input).toEqual({ cmd: 'ls' })
  })

  it('tool/result → runtime.tool_result', () => {
    const event = {
      type: 'tool/result',
      seq: 6,
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [{ tool_use_id: 'call-1', content: 'output' }],
        },
      },
    } as any
    const out = translateSessionEvent(event, ctx)
    expect(out!.type).toBe('runtime.tool_result')
    expect((out as any).toolUseId).toBe('call-1')
  })

  it('user/message → ignorable (null)', () => {
    const event = {
      type: 'user/message',
      seq: 7,
      data: {
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'user' },
      },
    } as any
    expect(translateSessionEvent(event, ctx)).toBeNull()
  })

  it('step/start → ignorable', () => {
    const event = { type: 'step/start', seq: 8, data: { turn: 1, step: 1 } } as any
    expect(translateSessionEvent(event, ctx)).toBeNull()
  })

  it('未映射事件清单非空（B1b 阶段补齐）', () => {
    const unmapped = listUnmappedEvents()
    expect(unmapped.length).toBeGreaterThan(0)
    // 一些已知的未映射项
    expect(unmapped).toContain('step/start')
    expect(unmapped).toContain('todo/write')
  })

  it('11 组映射表存在且每组至少 1 个 pair', () => {
    expect(ALL_SERVER_EVENT_GROUPS).toHaveLength(11)
    // 全组都在 — 与主计划 §5 G2 修正一致
    expect(ALL_SERVER_EVENT_GROUPS).toContain('Runtime')
    expect(ALL_SERVER_EVENT_GROUPS).toContain('Session')
    expect(ALL_SERVER_EVENT_GROUPS).toContain('Job')
    expect(ALL_SERVER_EVENT_GROUPS).toContain('Prompt')
    expect(ALL_SERVER_EVENT_GROUPS).toContain('System')
    expect(ALL_SERVER_EVENT_GROUPS).toContain('State')
    expect(ALL_SERVER_EVENT_GROUPS).toContain('Instance')
    expect(ALL_SERVER_EVENT_GROUPS).toContain('Queue')
    expect(ALL_SERVER_EVENT_GROUPS).toContain('Command')
    expect(ALL_SERVER_EVENT_GROUPS).toContain('StreamError')
    expect(ALL_SERVER_EVENT_GROUPS).toContain('Projection')
  })
})