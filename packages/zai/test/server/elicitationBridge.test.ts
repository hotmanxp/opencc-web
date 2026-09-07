// @ts-nocheck
/**
 * zai patch (2026-09-07, plan P2-2.5, worktree-dsh): 测试
 * bridgeElicitPendingToPromptElicit 把 vendor tool_use:elicit_pending
 * 翻译成 zai 内部 prompt.elicit ServerEvent, 让前端 SSE 渠道收到。
 *
 * elicit_pending 是 vendor 控制协议(createPrintRuntime-impl.ts:268
 *   if (subtype === 'elicitation') → options.elicitationBridge(...))
 * 触发的 MCP Elicitation 弹窗请求。zai 的 ElicitationRegistry 通过
 * prompt.elicit SSE 渠道接收用户答复。翻译层只负责 emit, 不负责
 * 注册到 Registry(后者是 elicitBridge 在 createPrintRuntime 安装时
 * 提供的 callback, 见 agentRuntime.ts:948+)。
 *
 * 测试覆盖:
 *   1. vendor emit elicit_pending → __zaiEventBus.emit('prompt.elicit')
 *   2. 字段透传(elicitationId / mcpServerName / message / mode / url /
 *      requestedSchema)
 *   3. 无 elicit event → 不 emit
 *   4. 缺 __zaiEventBus → silently skip
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eventBus } from '../../src/server/services/eventBus.js'

describe('bridgeElicitPendingToPromptElicit (vendor elicit_pending 翻译)', () => {
  // zai patch (2026-09-07, plan P2-2.5, worktree-dsh): 用 eventBus
  // spyOn 替代 __zaiEventBus 替换 —— agentRuntime.ts module init 强制
  // 把 eventBus 写到 globalThis.__zaiEventBus (line 135), 直接改
  // global 会被 module 行为覆盖, 用 spyOn eventBus.emit 才是稳定的。
  let emitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    emitSpy = vi.spyOn(eventBus, 'emit')
  })

  afterEach(() => {
    emitSpy.mockRestore()
  })

  it('vendor emit tool_use:elicit_pending → prompt.elicit ServerEvent', async () => {
    const { bridgeElicitPendingToPromptElicit } = await import(
      '../../src/server/services/agentRuntime.js'
    )
    bridgeElicitPendingToPromptElicit({
      type: 'tool_use:elicit_pending',
      id: 'req-1',
      elicitationId: 'elicit-1',
      mcpServerName: 'mcp-server-1',
      message: 'Need input',
      mode: 'form',
      url: undefined,
      requestedSchema: { type: 'object', properties: { x: { type: 'string' } } },
    })
    const elicitCalls = emitSpy.mock.calls.filter(
      (call) => (call[0] as any)?.type === 'prompt.elicit',
    )
    expect(elicitCalls).toHaveLength(1)
    const ev = elicitCalls[0][0] as any
    expect(ev.toolUseId).toBe('req-1')
    expect(ev.elicitationId).toBe('elicit-1')
    expect(ev.mcpServerName).toBe('mcp-server-1')
    expect(ev.message).toBe('Need input')
    expect(ev.mode).toBe('form')
    expect(ev.requestedSchema).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
    })
  })

  it('mode=url → 透传 url 字段', async () => {
    const { bridgeElicitPendingToPromptElicit } = await import(
      '../../src/server/services/agentRuntime.js'
    )
    bridgeElicitPendingToPromptElicit({
      type: 'tool_use:elicit_pending',
      id: 'req-2',
      elicitationId: 'elicit-2',
      mcpServerName: 'mcp-server-2',
      message: 'Visit URL',
      mode: 'url',
      url: 'https://example.com/auth',
    })
    const elicitCalls = emitSpy.mock.calls.filter(
      (call) => (call[0] as any)?.type === 'prompt.elicit',
    )
    expect(elicitCalls).toHaveLength(1)
    const ev = elicitCalls[0][0] as any
    expect(ev.mode).toBe('url')
    expect(ev.url).toBe('https://example.com/auth')
  })

  it('非 elicit_pending 事件 → 不 emit (silent skip)', async () => {
    const { bridgeElicitPendingToPromptElicit } = await import(
      '../../src/server/services/agentRuntime.js'
    )
    bridgeElicitPendingToPromptElicit({
      type: 'tool_use:ask_pending',
      id: 'req-3',
      toolName: 'AskUserQuestion',
    } as any)
    const elicitCalls = emitSpy.mock.calls.filter(
      (call) => (call[0] as any)?.type === 'prompt.elicit',
    )
    expect(elicitCalls).toHaveLength(0)
  })

  it('缺 __zaiEventBus → silently skip (不抛错)', async () => {
    // 临时改 globalThis.__zaiEventBus 为 undefined 模拟缺 bus 场景
    const originalBus = (globalThis as any).__zaiEventBus
    ;(globalThis as any).__zaiEventBus = undefined
    try {
      const { bridgeElicitPendingToPromptElicit } = await import(
        '../../src/server/services/agentRuntime.js'
      )
      // bridgeElicitPendingToPromptElicit 会先读 globalThis.__zaiEventBus;
      // 我们强制覆盖回去 undefined 后立即调用
      expect(() =>
        bridgeElicitPendingToPromptElicit({
          type: 'tool_use:elicit_pending',
          elicitationId: 'elicit-3',
          mcpServerName: 'mcp',
          message: 'test',
        }),
      ).not.toThrow()
    } finally {
      ;(globalThis as any).__zaiEventBus = originalBus
    }
  })
})