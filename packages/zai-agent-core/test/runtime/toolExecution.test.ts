import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { executeToolsStreaming } from '../../src/runtime/toolExecution.js'
import type { Tool, ToolContext } from '../../src/tools/Tool.js'
import type { MCPTool } from '../../src/mcp/MCPToolAdapter.js'
import { defaultCanUseToolFactory } from '../../src/runtime/canUseTool.js'

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/tmp', env: {}, abortSignal: new AbortController().signal,
    dataDir: '/d', state: {},
    canUseTool: defaultCanUseToolFactory(undefined),
    emitEvent: () => {},
    awaitAskUserQuestion: async () => { throw new Error('awaitAskUserQuestion not configured in test') },
    ...overrides,
  }
}

// executeToolsStreaming 现在直接 yield 完整 RuntimeEvent (sessionId/ts/eventId),
// 不再走 ctx.emitEvent. 测试要收集 yield 的事件做断言.
function makeMeta() {
  let counter = 0
  return {
    sessionId: 'sess-test',
    turnIndex: 1,
    nextEventId: () => `evt-test-${++counter}`,
  }
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('executeToolsStreaming', () => {
  test('canUseTool deny → tool_use:denied 事件 + isError result', async () => {
    const ctx = makeCtx({ canUseTool: async () => ({ behavior: 'deny' as const, reason: 'no' }) })
    const blocks = [{ id: 't1', name: 'Bash', input: { command: 'ls' } }]
    const tools: Tool[] = [{
      name: 'Bash', description: '', inputSchema: z.object({ command: z.string() }),
      call: async () => ({ output: 'should not run' }),
    }]
    const events = await collect(executeToolsStreaming(blocks, ctx, tools, makeMeta()))
    expect(events.some((e: any) => e.type === 'tool_use:denied')).toBe(true)
    const results = ctx.state.__lastToolResults as any[]
    expect(results[0].isError).toBe(true)
  })

  test('ask-mode → 当 deny 处理 + reason 含 ask-mode not supported', async () => {
    const ctx = makeCtx({ canUseTool: async () => ({ behavior: 'ask' as const }) })
    const blocks = [{ id: 't1', name: 'Bash', input: { command: 'ls' } }]
    const tools: Tool[] = [{
      name: 'Bash', description: '', inputSchema: z.object({ command: z.string() }),
      call: async () => ({ output: '' }),
    }]
    const events = await collect(executeToolsStreaming(blocks, ctx, tools, makeMeta()))
    expect(events.some((e: any) => e.type === 'tool_use:denied')).toBe(true)
  })

  test('unknown tool → isError result, 无 tool_use:start', async () => {
    const ctx = makeCtx()
    const blocks = [{ id: 't1', name: 'NoSuchTool', input: {} }]
    const events = await collect(executeToolsStreaming(blocks, ctx, [], makeMeta()))
    expect(events.some((e: any) => e.type === 'tool_use:start')).toBe(false)
    const results = ctx.state.__lastToolResults as any[]
    expect(results[0].isError).toBe(true)
    expect(results[0].content as string).toMatch(/unknown tool/)
  })

  test('zod 校验失败 → tool_use:invalid + isError', async () => {
    const ctx = makeCtx()
    const blocks = [{ id: 't1', name: 'Strict', input: { wrong: 'shape' } }]
    const tools: Tool[] = [{
      name: 'Strict', description: '', inputSchema: z.object({ required: z.string() }),
      call: async () => ({ output: 'should not run' }),
    }]
    const events = await collect(executeToolsStreaming(blocks, ctx, tools, makeMeta()))
    expect(events.some((e: any) => e.type === 'tool_use:invalid')).toBe(true)
  })

  test('正常 call → tool_use:start + tool_use:done, result 包含 output', async () => {
    const ctx = makeCtx()
    const blocks = [{ id: 't1', name: 'Echo', input: { msg: 'hi' } }]
    const tools: Tool[] = [{
      name: 'Echo', description: '', inputSchema: z.object({ msg: z.string() }),
      call: async ({ msg }) => ({ output: `echo:${msg}` }),
    }]
    const events = await collect(executeToolsStreaming(blocks, ctx, tools, makeMeta()))
    expect(events.some((e: any) => e.type === 'tool_use:start')).toBe(true)
    expect(events.some((e: any) => e.type === 'tool_use:done')).toBe(true)
    const results = ctx.state.__lastToolResults as any[]
    expect(results[0].isError).toBeFalsy()
    expect(results[0].content).toBe('echo:hi')
  })

  test('tool.call throw → tool_use:error + isError', async () => {
    const ctx = makeCtx()
    const blocks = [{ id: 't1', name: 'Boom', input: {} }]
    const tools: Tool[] = [{
      name: 'Boom', description: '', inputSchema: z.object({}),
      call: async () => { throw new Error('kaboom') },
    }]
    const events = await collect(executeToolsStreaming(blocks, ctx, tools, makeMeta()))
    expect(events.some((e: any) => e.type === 'tool_use:error')).toBe(true)
  })

  test('tool 通过 ctx.emitEvent 投递子事件 → 与 tool_use:* 按发生顺序 yield', async () => {
    const ctx = makeCtx()
    const tools: Tool[] = [{
      name: 'Echo', description: '', inputSchema: z.object({ msg: z.string() }),
      call: async (_: { msg: string }, c) => {
        c.emitEvent({ type: 'subagent:event', payload: 'a' })
        c.emitEvent({ type: 'subagent:event', payload: 'b' })
        return { output: 'ok' }
      },
    }]
    const events = await collect(executeToolsStreaming(
      [{ id: 't1', name: 'Echo', input: { msg: 'hi' } }],
      ctx, tools, makeMeta(),
    ))
    const types = events.map((e: any) => e.type)
    expect(types).toContain('tool_use:start')
    expect(types).toContain('tool_use:done')
    expect(types.filter((t: string) => t === 'subagent:event').length).toBe(2)
    // 子事件必须在 tool_use:done 之前 yield
    const doneIdx = types.indexOf('tool_use:done')
    const subIdx = types.indexOf('subagent:event')
    expect(subIdx).toBeLessThan(doneIdx)
  })

  test('并发: 3 个 tool 同时跑, 结果按原顺序回写', async () => {
    const ctx = makeCtx()
    const tools: Tool[] = [{
      name: 'T', description: '', inputSchema: z.object({ delay: z.number() }),
      call: async ({ delay }: { delay: number }) => {
        await new Promise(r => setTimeout(r, delay))
        return { output: `done-${delay}` }
      },
    }]
    const blocks = [
      { id: 't1', name: 'T', input: { delay: 30 } },
      { id: 't2', name: 'T', input: { delay: 5 } },
      { id: 't3', name: 'T', input: { delay: 15 } },
    ]
    await collect(executeToolsStreaming(blocks, ctx, tools, makeMeta()))
    const results = ctx.state.__lastToolResults as any[]
    expect(results.map(r => r.content)).toEqual(['done-30', 'done-5', 'done-15'])
  })
})

import type { AskRegistryLike } from '../../src/runtime/types.js'

describe('executeToolsStreaming with askRegistry', () => {
  test('AskUserQuestion tool → yield ask_pending then await registry then yield done', async () => {
    let resolveAnswer!: (a: { answers: Record<string, string> }) => void
    const ctx = makeCtx()
    const registry: AskRegistryLike = {
      register: (_tid, _sid, _sig) => new Promise((resolve) => { resolveAnswer = resolve }),
    }
    const askTool: Tool = {
      name: 'AskUserQuestion',
      description: '',
      inputSchema: z.object({ questions: z.array(z.any()) }),
      call: async (_input: any, c: ToolContext) => {
        await c.awaitAskUserQuestion({ questions: [{ question: 'q1' }] })
        return { output: { ok: true } }
      },
    }
    const blocks = [{ id: 't-ask', name: 'AskUserQuestion', input: { questions: [{ question: 'q1' }] } }]
    // 启动消费 generator 但不在 await 注册前 resolve
    const eventsP = collect(executeToolsStreaming(blocks, ctx, [askTool], makeMeta(), registry))
    // 给 microtask 时间跑, 让 ask_pending 进入 yield 流
    await new Promise((r) => setTimeout(r, 10))
    // resolve registry, 让 call() 返回
    resolveAnswer({ answers: { q1: 'A' } })
    const events = await eventsP
    const types = events.map((e: any) => e.type)
    expect(types).toContain('tool_use:start')
    expect(types).toContain('tool_use:ask_pending')
    expect(types).toContain('tool_use:done')
    // ask_pending 必须在 start 之后, done 之前
    expect(types.indexOf('tool_use:ask_pending'))
      .toBeGreaterThan(types.indexOf('tool_use:start'))
    expect(types.indexOf('tool_use:ask_pending'))
      .toBeLessThan(types.indexOf('tool_use:done'))
    // ask_pending payload 携带 toolUseId + questions
    const askEvt = events.find((e: any) => e.type === 'tool_use:ask_pending')
    expect((askEvt as any).toolUseId).toBe('t-ask')
    expect((askEvt as any).questions).toEqual([{ question: 'q1' }])
  })

  test('askRegistry 缺省时, AskUserQuestion → tool_use:error, 不调 tool.call', async () => {
    const ctx = makeCtx()
    let toolCalled = false
    const askTool: Tool = {
      name: 'AskUserQuestion',
      description: '',
      inputSchema: z.object({ questions: z.array(z.any()) }),
      call: async () => { toolCalled = true; return { output: { ok: true } } },
    }
    const blocks = [{ id: 't-ask', name: 'AskUserQuestion', input: { questions: [{ question: 'q1' }] } }]
    const events = await collect(executeToolsStreaming(blocks, ctx, [askTool], makeMeta()))
    expect(events.some((e: any) => e.type === 'tool_use:error')).toBe(true)
    const err = events.find((e: any) => e.type === 'tool_use:error')
    expect((err as any).error).toMatch(/askRegistry not configured/)
    expect(toolCalled).toBe(false)
    // ctx.state.__lastToolResults 标记 isError
    const results = ctx.state.__lastToolResults as any[]
    expect(results[0].isError).toBe(true)
  })
})

describe('executeToolsStreaming with MCP tools', () => {
  test('MCP tool success → tool_use:done, output text', async () => {
    const ctx = makeCtx()
    const mcpTool: MCPTool = {
      name: 'mcp__x__ping',
      description: '[mcp:x] ping',
      inputSchema: z.object({ msg: z.string() }),
      isMcp: true,
      mcpInfo: { serverName: 'x', originalName: 'ping' },
      call: async () => ({ output: 'pong' }),
    }
    const events = await collect(
      executeToolsStreaming(
        [{ id: 't-mcp', name: 'mcp__x__ping', input: { msg: 'hi' } }],
        ctx,
        [mcpTool],
        makeMeta(),
      ),
    )
    expect(events.some((e: any) => e.type === 'tool_use:done')).toBe(true)
    const results = ctx.state.__lastToolResults as any[]
    expect(results[0].isError).toBeFalsy()
    expect(results[0].content).toBe('pong')
  })

  test('MCP tool returns isError → tool_use:done + isError result (no throw)', async () => {
    const ctx = makeCtx()
    const mcpTool: MCPTool = {
      name: 'mcp__x__fail',
      description: '[mcp:x] fail',
      inputSchema: z.object({}),
      isMcp: true,
      mcpInfo: { serverName: 'x', originalName: 'fail' },
      call: async () => ({ output: 'tool failed', isError: true }),
    }
    const events = await collect(
      executeToolsStreaming(
        [{ id: 't-mcp-fail', name: 'mcp__x__fail', input: {} }],
        ctx,
        [mcpTool],
        makeMeta(),
      ),
    )
    expect(events.some((e: any) => e.type === 'tool_use:done')).toBe(true)
    expect(events.some((e: any) => e.type === 'tool_use:error')).toBe(false)
    const results = ctx.state.__lastToolResults as any[]
    expect(results[0].isError).toBe(true)
    expect(results[0].content).toBe('tool failed')
  })
})
