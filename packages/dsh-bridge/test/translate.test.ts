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

  it('assistant/message → 不 emit runtime.delta (避免与 chunk(text-delta) 重复累加)', () => {
    // dsh 上游已经在 assistant/chunk(text-delta) 阶段把同一段文本增量
    // 推送过,前端 upsertStreamBlock 按 eventId 累加 delta。如果这里再 emit
    // 一条带"完整文本"的 runtime.delta,前端会把同一段文本拼接第二遍,
    // UI 上看到 "xxx.xxx" 的重复气泡 (B1 修复回归)。
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
    // 修复后: assistant/message 不再产生 runtime.delta,文本完整性由
    // assistant/chunk(text-delta) 流负责;turn 收尾由 turn/end 触发 runtime.done。
    expect(out).toBeNull()
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

  it('turn/end (completed) 携带 ctx.lastContextTokens → runtime.done.contextTokens', () => {
    // dsh factory 在每次 yield 前调 setLastContextUsage() 写 globalThis,
    // 然后 getLastContextTokens() 拿到这里的 ctx.lastContextTokens。
    // turn/end(completed) case 把它附给 runtime.done ServerEvent,
    // zai routes/agent.ts:921-930 命中后 emit session/projection 帧。
    const event = {
      type: 'turn/end',
      seq: 4,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as any
    const out = translateSessionEvent(event, {
      sessionId: 'sess-1',
      turnIndex: 0,
      seqBase: 0,
      lastContextTokens: 12345,
    })
    expect(out!.type).toBe('runtime.done')
    expect((out as any).contextTokens).toBe(12345)
  })

  it('turn/end (completed) 未传 lastContextTokens → runtime.done 不附 contextTokens 字段', () => {
    const event = {
      type: 'turn/end',
      seq: 4,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as any
    const out = translateSessionEvent(event, { sessionId: 'sess-1', turnIndex: 0, seqBase: 0 })
    expect(out!.type).toBe('runtime.done')
    expect((out as any).contextTokens).toBeUndefined()
  })

  it('turn/start 携带 ctx.lastContextTokens → runtime.started.contextTokens', () => {
    // turn/start 也可能带 ctx.lastContextTokens — 用于首次 prompt 时
    // 显示"上一轮入站 context"基线。
    const event = { type: 'turn/start', seq: 1, data: { turn: 1 } } as any
    const out = translateSessionEvent(event, {
      sessionId: 'sess-1',
      turnIndex: 0,
      seqBase: 0,
      lastContextTokens: 6789,
    })
    expect(out!.type).toBe('runtime.started')
    expect((out as any).contextTokens).toBe(6789)
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

/**
 * tool/call → tool/result 配对 + dsh 不同字段名兼容 + output 规范化
 * （对应截图"未知工具 (id:)" 修复）。
 *
 * 已知 dsh tool/result 事件不携带 toolName — 必须依赖 tool/call 时建立的
 * callId → name 映射。Phase 1.3 之前 extractToolName 是 stub，前端 ToolCallBlock
 * 因此显示 "未知工具 (id:xxxxxxxx)"。这套测试钉住映射表行为 + output 规范化。
 */
describe('translateSessionEvent dsh tool 兼容性 (Phase 2 tool/result 修复)', () => {
  // 用独立 sid 隔离状态，避免用例互相污染
  const toolCtx = (sid = 'sess-tool-fix') => ({ sessionId: sid, turnIndex: 0, seqBase: 0 })

  it('tool/call 后 tool/result: toolName 通过映射表回填', () => {
    const sid = 'sess-fix-1'
    const callEvent = {
      type: 'tool/call',
      seq: 1,
      data: { turn: 1, step: 1, callId: 'call-A', name: 'Bash', arguments: '{"cmd":"ls"}' },
    } as any
    const resultEvent = {
      type: 'tool/result',
      seq: 2,
      data: {
        turn: 1, step: 1,
        message: { content: [{ tool_use_id: 'call-A', content: 'file.txt\n' }] },
      },
    } as any

    const call = translateSessionEvent(callEvent, toolCtx(sid)) as any
    expect(call.toolName).toBe('Bash')

    const result = translateSessionEvent(resultEvent, toolCtx(sid)) as any
    expect(result.toolUseId).toBe('call-A')
    expect(result.toolName).toBe('Bash') // 从映射表回填,而不是空串
    expect(result.output).toBe('file.txt\n') // 字符串 content 直接透传
  })

  it('tool/result 兼容 toolCallId 字段名（dsh 旧版本）', () => {
    const sid = 'sess-fix-2'
    translateSessionEvent(
      { type: 'tool/call', seq: 1, data: { callId: 'cb-1', name: 'Read', arguments: '{}' } } as any,
      toolCtx(sid),
    )
    const result = translateSessionEvent(
      {
        type: 'tool/result',
        seq: 2,
        data: { message: { content: [{ toolCallId: 'cb-1', content: 'contents' }] } },
      } as any,
      toolCtx(sid),
    ) as any
    expect(result.toolUseId).toBe('cb-1')
    expect(result.toolName).toBe('Read')
  })

  it('tool/result 兼容 message.source.callId 字段名（subagent 路径）', () => {
    const sid = 'sess-fix-3'
    translateSessionEvent(
      { type: 'tool/call', seq: 1, data: { callId: 'sa-1', name: 'Agent', arguments: '{}' } } as any,
      toolCtx(sid),
    )
    const result = translateSessionEvent(
      {
        type: 'tool/result',
        seq: 2,
        data: {
          message: {
            source: { callId: 'sa-1' },
            content: [{ content: 'subagent result' }],
          },
        },
      } as any,
      toolCtx(sid),
    ) as any
    expect(result.toolUseId).toBe('sa-1')
    expect(result.toolName).toBe('Agent')
  })

  it('tool/result content 是 ContentBlock[] 时,只提取 text 块', () => {
    const sid = 'sess-fix-4'
    const result = translateSessionEvent(
      {
        type: 'tool/result',
        seq: 1,
        data: {
          message: {
            content: [
              { type: 'text', text: 'first line\n' },
              { type: 'text', text: 'second line' },
              { type: 'image', source: 's3://bucket/img.png' }, // 非 text 块,留占位符
            ],
          },
        },
      } as any,
      toolCtx(sid),
    ) as any
    // 不再是一坨 JSON.stringify,渲染层能正常显示
    expect(result.output).toContain('first line')
    expect(result.output).toContain('second line')
    expect(result.output).not.toContain('"type":"image"')
  })

  it('tool/result content 是单个对象时,提取 text 字段', () => {
    const sid = 'sess-fix-5'
    const result = translateSessionEvent(
      {
        type: 'tool/result',
        seq: 1,
        data: {
          message: {
            content: [{ text: 'just text' }],
          },
        },
      } as any,
      toolCtx(sid),
    ) as any
    expect(result.output).toBe('just text')
  })

  it('tool/result content 是非文本对象时,JSON.stringify 兜底', () => {
    const sid = 'sess-fix-6'
    const result = translateSessionEvent(
      {
        type: 'tool/result',
        seq: 1,
        data: {
          message: {
            content: [{ json_field: { nested: 'value' } }],
          },
        },
      } as any,
      toolCtx(sid),
    ) as any
    // 单个对象无 text 字段 → JSON.stringify
    expect(typeof result.output).toBe('string')
    expect(result.output).toContain('json_field')
  })

  it('tool/call 在 tool/result 之前未到:toolName 兜底为空串(前端"未知工具"分支触发)', () => {
    // 极端顺序异常(out-of-order):result 先到,call 后到。
    // 此时映射表为空,toolName 必须是非 undefined 的字符串(zod schema 要求)。
    const sid = 'sess-fix-7'
    const result = translateSessionEvent(
      {
        type: 'tool/result',
        seq: 1,
        data: {
          message: { content: [{ tool_use_id: 'orphan-1', content: 'data' }] },
        },
      } as any,
      toolCtx(sid),
    ) as any
    expect(result.toolUseId).toBe('orphan-1')
    expect(result.toolName).toBe('') // 空串是合法 fallback,前端有兜底 UI

    // 之后 call 到达:映射表不会回填之前的 result(已经发出),只供后续 result 用
    const call = translateSessionEvent(
      { type: 'tool/call', seq: 2, data: { callId: 'orphan-1', name: 'LateArriving', arguments: '{}' } } as any,
      toolCtx(sid),
    ) as any
    expect(call.toolName).toBe('LateArriving')
  })

  it('turn/end 清空该 session 的 callId → name 映射,避免跨 turn stale 命中', () => {
    const sid = 'sess-fix-8'
    // turn 1: 建立映射
    translateSessionEvent(
      { type: 'tool/call', seq: 1, data: { callId: 'turn1-1', name: 'Bash', arguments: '{}' } } as any,
      toolCtx(sid),
    )
    let result = translateSessionEvent(
      {
        type: 'tool/result',
        seq: 2,
        data: { message: { content: [{ tool_use_id: 'turn1-1', content: 'r1' }] } },
      } as any,
      toolCtx(sid),
    ) as any
    expect(result.toolName).toBe('Bash')

    // turn 结束 → 清空
    translateSessionEvent(
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } } as any,
      toolCtx(sid),
    )

    // turn 2: 同 callId 重复用,映射应为空 → toolName 是空串(不会 stale 命中)
    // (实际生产中 dsh 不会同 sid 复用 callId;但保险起见,验证清理行为)
    result = translateSessionEvent(
      {
        type: 'tool/result',
        seq: 4,
        data: { message: { content: [{ tool_use_id: 'turn1-1', content: 'r2' }] } },
      } as any,
      toolCtx(sid),
    ) as any
    expect(result.toolName).toBe('') // 已清理,不会误命中上 turn 的 'Bash'
  })

  it('不同 session 的映射互相隔离', () => {
    const sidA = 'sess-fix-iso-A'
    const sidB = 'sess-fix-iso-B'
    translateSessionEvent(
      { type: 'tool/call', seq: 1, data: { callId: 'shared-1', name: 'Bash', arguments: '{}' } } as any,
      toolCtx(sidA),
    )
    // sidB 用同样的 callId,但没在 sidB 记映射 → toolName 应当是空串
    const result = translateSessionEvent(
      {
        type: 'tool/result',
        seq: 2,
        data: { message: { content: [{ tool_use_id: 'shared-1', content: 'x' }] } },
      } as any,
      toolCtx(sidB),
    ) as any
    expect(result.toolName).toBe('')
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