import { describe, it, expect } from 'vitest'
import {
  translateSessionEvent,
  subscribeDshInternalEvents,
  ALL_SERVER_EVENT_GROUPS,
  listUnmappedEvents,
  summarizeMapping,
  SESSION_EVENT_TO_SERVER_GROUP_MAP,
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
    // todo/write 现在是 pair（Phase 1.3 新增 state.v2_task.changed 翻译）
    expect(unmapped).not.toContain('todo/write')
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

describe('translateSessionEvent Phase 1.3: 完整 13 SessionEventMap 类型', () => {
  it('todo/write → state.v2_task.changed', () => {
    const event = {
      type: 'todo/write',
      seq: 9,
      data: {
        todos: [
          { id: 't1', status: 'in_progress', content: 'fix bug' },
          { id: 't2', status: 'pending', content: 'add test' },
        ],
      },
    } as any
    const out = translateSessionEvent(event, ctx)
    expect(out).not.toBeNull()
    expect(out!.type).toBe('state.v2_task.changed')
    expect((out as any).action).toBe('upsert')
    expect((out as any).task.todos).toHaveLength(2)
  })

  it('todo/write 空数组也正常翻译（边界）', () => {
    const event = { type: 'todo/write', seq: 10, data: { todos: [] } } as any
    const out = translateSessionEvent(event, ctx)
    expect(out).not.toBeNull()
    expect(out!.type).toBe('state.v2_task.changed')
    expect((out as any).task.todos).toEqual([])
  })

  it('session/end-seed → ignorable', () => {
    const event = { type: 'session/end-seed', seq: 11, data: {} } as any
    expect(translateSessionEvent(event, ctx)).toBeNull()
  })

  it('request/header → ignorable', () => {
    const event = { type: 'request/header', seq: 12, data: { header: {}, reason: 'begin' } } as any
    expect(translateSessionEvent(event, ctx)).toBeNull()
  })

  it('request/context → ignorable', () => {
    const event = { type: 'request/context', seq: 13, data: {} } as any
    expect(translateSessionEvent(event, ctx)).toBeNull()
  })
})

describe('translateSessionEvent Phase 1.3: 11 组映射表完整性', () => {
  it('summarizeMapping 返回 11 组的 pair/ignorable 计数', () => {
    const summary = summarizeMapping()
    expect(Object.keys(summary)).toHaveLength(11)
    expect(summary.Runtime.pair).toBeGreaterThan(0)
    // 一些组当前只有 ignorable（forward-compat 占位）
    expect(summary.State.pair + summary.State.ignorable).toBe(0)
    expect(summary.Instance.pair + summary.Instance.ignorable).toBe(0)
  })

  it('SESSION_EVENT_TO_SERVER_GROUP_MAP 包含 Runtime 的 13 个 SessionEventMap 类型', () => {
    const runtime = SESSION_EVENT_TO_SERVER_GROUP_MAP.Runtime
    // SessionEventMap 实际有的 13 个
    const expected = [
      'turn/start', 'turn/end', 'step/start', 'step/end', 'user/message',
      'assistant/chunk', 'assistant/message', 'tool/call', 'tool/result',
      'todo/write', 'request/header', 'request/context', 'session/end-seed',
    ]
    for (const t of expected) {
      expect(runtime[t]).toBeDefined()
    }
  })

  it('listUnmappedEvents 只返回 ignorable 项（无 pair）', () => {
    const unmapped = listUnmappedEvents()
    // 不含 todo/write（已升为 pair）
    expect(unmapped).not.toContain('todo/write')
    // 不含 Runtime 核心子集
    expect(unmapped).not.toContain('turn/start')
    expect(unmapped).not.toContain('tool/call')
    // 包含一些边界 marker
    expect(unmapped).toContain('step/start')
  })
})

describe('subscribeDshInternalEvents (Phase 1.3)', () => {
  // 简单 mock ctx，提供 on() 注册并保留 callback
  function mockCtx() {
    const handlers: Record<string, Array<(payload: unknown) => void>> = {}
    return {
      handlers,
      on(event: string, cb: (payload: unknown) => void) {
        if (!handlers[event]) handlers[event] = []
        handlers[event].push(cb)
        return () => {
          handlers[event] = handlers[event].filter((h) => h !== cb)
        }
      },
    }
  }

  it('订阅 agent/status → emit instance.status', () => {
    const ctxMock = mockCtx()
    const events: Array<{ type: string; status?: string; agentId?: string }> = []
    const dispose = subscribeDshInternalEvents(ctxMock as any, (e) => events.push(e as any))
    // 触发 agent/status
    ctxMock.handlers['agent/status']?.[0]({ agent: {}, status: 'running', id: 'agent-1' })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('instance.status')
    expect(events[0].agentId).toBe('agent-1')
    expect(events[0].status).toBe('running')
    dispose()
  })

  it('订阅 internal/status → emit instance.internal_status', () => {
    const ctxMock = mockCtx()
    const events: Array<{ type: string; mode?: string }> = []
    const dispose = subscribeDshInternalEvents(ctxMock as any, (e) => events.push(e as any))
    ctxMock.handlers['internal/status']?.[0]({ mode: 'maintenance', agentId: 'agent-2' })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('instance.internal_status')
    expect(events[0].mode).toBe('maintenance')
    dispose()
  })

  it('dispose 移除全部 hook', () => {
    const ctxMock = mockCtx()
    const events: unknown[] = []
    const dispose = subscribeDshInternalEvents(ctxMock as any, (e) => events.push(e as any))
    const initialCount = ctxMock.handlers['agent/status']?.length ?? 0
    expect(initialCount).toBeGreaterThan(0)
    dispose()
    // dispose 后 handlers 应为空数组（mock 行为）
    expect(ctxMock.handlers['agent/status']?.length ?? 0).toBe(0)
    // 触发已移除的 handler 不应 emit
    const remaining = ctxMock.handlers['agent/status'] ?? []
    for (const h of remaining) h({ status: 'x' })
    expect(events).toHaveLength(0)
  })
})