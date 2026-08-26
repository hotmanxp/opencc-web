// Task 1: routes/command.ts 在入口 / 5 处出口 emit command.run /
// command.done 配对事件, commandId 一致, durationMs 真实, args 1KB 截断。
//
// 测试策略(借鉴 command.test.ts 已有 patterns):
// - supertest 挂载 commandRouter 到 /agent/command
// - mock eventBus.js 让 emitSpy 收集事件, 验证 emit 调用参数
// - mock agentRuntime.js 让 getCurrentSessionId / getRuntime / resolveSkillPrompt
//   走 stub(对齐 command.test.ts 顶部)
// - vi.resetModules 让 registry / module-level 单例每个 case 干净
// - 注册 fake builtin commands 进 registry, 覆盖 local-cleared /
//   local-compacted / local-error / prompt branch / skill fallthrough /
//   unknown / 异常 这 7 条路径
//
// 重要: vi.hoisted 让 emitSpy 跨 vi.mock factory 边界可见 — plain `let` 会
// 因 vi.mock hoisting 解析不到。

import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Command } from '@zn-ai/zn-agent-core'

const { emitSpy, resolveSkillPromptMock } = vi.hoisted(() => ({
  emitSpy: vi.fn(),
  // 默认返回 null (= unknown 路径); 走 skill fallthrough 的 case 临时
  // mockResolvedValue('字符串') 覆盖. 这样每个 case 之间不会相互污染
  // (比 vi.doMock 更稳, 后者会粘到后续 case 的 module 解析).
  resolveSkillPromptMock: vi.fn(async () => null),
}))

vi.mock('../../../src/server/services/eventBus.js', () => ({
  eventBus: {
    emit: emitSpy,
    // 其他方法 routes/command.ts 不调用, 不必 stub
  },
}))

vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getRuntime: () => ({ config: {} }),
  getCurrentSessionId: () => null,
  resolveSkillPrompt: resolveSkillPromptMock,
}))

async function loadRouter() {
  const mod = await import('../../../src/server/routes/command.js')
  return mod.commandRouter
}

function buildApp(router: express.IRouter) {
  const app = express()
  app.use(express.json())
  app.use('/agent', router)
  return app
}

async function mountApp() {
  const router = await loadRouter()
  return buildApp(router)
}

beforeEach(() => {
  emitSpy.mockReset()
  resolveSkillPromptMock.mockReset()
  resolveSkillPromptMock.mockResolvedValue(null)
  vi.resetModules()
})

async function getRegistry() {
  const { getCommandRegistry } = await import('@zn-ai/zn-agent-core')
  return getCommandRegistry()
}

// 过滤 command.run / command.done 事件, 返回扁平列表(忽略其它事件,如
// future 子流程 emit; 当前 routes/command.ts 不应 emit 其它事件, 这层
// 过滤是防御性的, 避免后续扩展导致 flake).
function lifecycleEvents() {
  return emitSpy.mock.calls
    .map(([e]) => e)
    .filter((e) => e?.type === 'command.run' || e?.type === 'command.done')
}

describe('POST /agent/command — command.run / command.done lifecycle', () => {
  it('local command cleared 路径 emit run + done(cleared) commandId 一致', async () => {
    const reg = await getRegistry()
    reg.register({
      type: 'local',
      name: 'fake-cleared',
      description: 'test',
      call: async () => ({ kind: 'cleared' }),
    } as Command)

    const app = await mountApp()
    const res = await request(app)
      .post('/agent/command')
      .send({ name: 'fake-cleared', args: '', sessionId: 'sess-1' })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('cleared')

    const events = lifecycleEvents()
    expect(events).toHaveLength(2)
    const [run, done] = events
    expect(run.type).toBe('command.run')
    expect(done.type).toBe('command.done')
    expect(run.commandId).toBe(done.commandId)
    expect(run.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(run.name).toBe('fake-cleared')
    expect(done.name).toBe('fake-cleared')
    expect(run.sessionId).toBe('sess-1')
    expect(done.sessionId).toBe('sess-1')
    expect(run.trigger).toBe('user')
    expect(done.result).toBe('cleared')
    expect(done.durationMs).toBeGreaterThanOrEqual(0)
    expect(run.ts).toBeLessThanOrEqual(done.ts)
  })

  it('local command compacted 路径 emit done(compacted)', async () => {
    const reg = await getRegistry()
    reg.register({
      type: 'local',
      name: 'fake-compacted',
      description: 'test',
      call: async () => ({ kind: 'compacted', removedMessages: 3, summary: 'sum' }),
    } as Command)

    const app = await mountApp()
    const res = await request(app)
      .post('/agent/command')
      .send({ name: 'fake-compacted', args: '' })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('compacted')

    const events = lifecycleEvents()
    expect(events).toHaveLength(2)
    expect(events[1].result).toBe('compacted')
  })

  it('local command status 路径 emit done(status)', async () => {
    const reg = await getRegistry()
    reg.register({
      type: 'local',
      name: 'fake-status',
      description: 'test',
      call: async () => ({ kind: 'status', payload: { ok: true } }),
    } as Command)

    const app = await mountApp()
    const res = await request(app)
      .post('/agent/command')
      .send({ name: 'fake-status', args: '' })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('status')

    const events = lifecycleEvents()
    expect(events[1].result).toBe('status')
  })

  it('local command message 路径 emit done(message)', async () => {
    const reg = await getRegistry()
    reg.register({
      type: 'local',
      name: 'fake-message',
      description: 'test',
      call: async () => ({ kind: 'message', text: 'hi' }),
    } as Command)

    const app = await mountApp()
    const res = await request(app)
      .post('/agent/command')
      .send({ name: 'fake-message', args: '' })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('message')

    const events = lifecycleEvents()
    expect(events[1].result).toBe('message')
  })

  it('local command error 路径 emit done(error, message)', async () => {
    const reg = await getRegistry()
    reg.register({
      type: 'local',
      name: 'fake-error',
      description: 'test',
      call: async () => ({ kind: 'error', message: 'boom' }),
    } as Command)

    const app = await mountApp()
    const res = await request(app)
      .post('/agent/command')
      .send({ name: 'fake-error', args: '' })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('error')

    const events = lifecycleEvents()
    expect(events[1].result).toBe('error')
    expect(events[1].error).toBe('boom')
  })

  it('local command call 抛错 → 500 + done(error, message), 仍配对', async () => {
    const reg = await getRegistry()
    reg.register({
      type: 'local',
      name: 'fake-throws',
      description: 'test',
      call: async () => {
        throw new Error('call blew up')
      },
    } as Command)

    const app = await mountApp()
    const res = await request(app)
      .post('/agent/command')
      .send({ name: 'fake-throws', args: '' })

    expect(res.status).toBe(500)
    expect(res.body.type).toBe('error')
    expect(res.body.payload?.message).toContain('call blew up')

    const events = lifecycleEvents()
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('command.run')
    expect(events[1].type).toBe('command.done')
    expect(events[1].result).toBe('error')
    expect(events[1].error).toContain('call blew up')
  })

  it('PromptCommand 路径 emit done(prompt)', async () => {
    const reg = await getRegistry()
    reg.register({
      type: 'prompt',
      name: 'fake-prompt',
      description: 'test',
      getPromptForCommand: async () => [{ type: 'text', text: 'rendered' }],
    } as Command)

    const app = await mountApp()
    const res = await request(app)
      .post('/agent/command')
      .send({ name: 'fake-prompt', args: '' })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('prompt')
    expect(res.body.payload?.rendered).toBe('rendered')

    const events = lifecycleEvents()
    expect(events[1].result).toBe('prompt')
  })

  it('PromptCommand handler 抛错 → 200 + done(error, message)', async () => {
    const reg = await getRegistry()
    reg.register({
      type: 'prompt',
      name: 'fake-prompt-throws',
      description: 'test',
      getPromptForCommand: async () => {
        throw new Error('prompt boom')
      },
    } as Command)

    const app = await mountApp()
    const res = await request(app)
      .post('/agent/command')
      .send({ name: 'fake-prompt-throws', args: '' })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('error')
    expect(res.body.payload?.message).toContain('prompt boom')

    const events = lifecycleEvents()
    expect(events[1].result).toBe('error')
    expect(events[1].error).toContain('prompt boom')
  })

  it('skill fallthrough 路径 emit done(prompt)', async () => {
    // 临时让 resolveSkillPrompt 返回非 null 字符串, 触发 skill fallthrough
    // 路径 (routes/command.ts 走 `if (rendered !== null)` 分支).
    resolveSkillPromptMock.mockResolvedValueOnce('rendered-skill')

    const app = await mountApp()
    const res = await request(app)
      .post('/agent/command')
      .send({ name: 'some-skill', args: 'foo' })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('prompt')
    expect(res.body.payload?.rendered).toBe('rendered-skill')

    const events = lifecycleEvents()
    expect(events[1].result).toBe('prompt')
  })

  it('unknown command (无内置 + 无 skill) 路径 emit done(unknown)', async () => {
    const app = await mountApp()
    const res = await request(app)
      .post('/agent/command')
      .send({ name: 'nope-not-found', args: '' })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('unknown')

    const events = lifecycleEvents()
    expect(events[1].result).toBe('unknown')
  })

  it('args 超过 1024 字节时截断 + argsTruncated:true', async () => {
    const reg = await getRegistry()
    reg.register({
      type: 'local',
      name: 'fake-args',
      description: 'test',
      call: async () => ({ kind: 'cleared' }),
    } as Command)

    const longArgs = 'x'.repeat(2048)
    const app = await mountApp()
    await request(app)
      .post('/agent/command')
      .send({ name: 'fake-args', args: longArgs })

    const events = lifecycleEvents()
    expect(events[0].args).toHaveLength(1024)
    expect(events[0].argsTruncated).toBe(true)
  })

  it('args 恰好 1024 字节时 argsTruncated 不设(false 边界)', async () => {
    const reg = await getRegistry()
    reg.register({
      type: 'local',
      name: 'fake-args2',
      description: 'test',
      call: async () => ({ kind: 'cleared' }),
    } as Command)

    const exactArgs = 'x'.repeat(1024)
    const app = await mountApp()
    await request(app)
      .post('/agent/command')
      .send({ name: 'fake-args2', args: exactArgs })

    const events = lifecycleEvents()
    expect(events[0].args).toHaveLength(1024)
    expect(events[0].argsTruncated).toBeUndefined()
  })

  it('不带 name 的请求 emit run("", ...) + done(unknown)', async () => {
    const app = await mountApp()
    const res = await request(app)
      .post('/agent/command')
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('unknown')

    const events = lifecycleEvents()
    expect(events[0].name).toBe('')
    expect(events[1].name).toBe('')
    expect(events[1].result).toBe('unknown')
  })

  it('sessionId 缺失时 sid 兜底空串, eventBus 仍能 emit', async () => {
    const reg = await getRegistry()
    reg.register({
      type: 'local',
      name: 'fake-cleared',
      description: 'test',
      call: async () => ({ kind: 'cleared' }),
    } as Command)

    const app = await mountApp()
    const res = await request(app)
      .post('/agent/command')
      .send({ name: 'fake-cleared' })

    expect(res.status).toBe(200)
    const events = lifecycleEvents()
    expect(events[0].sessionId).toBe('')
    expect(events[1].sessionId).toBe('')
  })
})
