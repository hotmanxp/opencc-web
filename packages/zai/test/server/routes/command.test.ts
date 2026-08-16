// Task 6: routes/command.ts 的 prompt 分支(handler 抛错时)兜底为
// {type:'error', payload:{message}},而非 500。
//
// 测试策略:
// - 用 supertest 直接挂载 commandRouter 到 /agent/command 路径
//   (对齐 src/server/routes/agent.ts:110 的真实挂载方式
//    `router.use('/agent', commandRouter)`)。
// - 路由里 `getRuntime()` 在 runtime 未 init 时会 throw,这里 mock
//   agentRuntime.js 把它返成带空 config 的 stub(只要不抛就行,prompt
//   分支不读 runtime 的实际能力,只读 `config.defaultModel` 这一个可选
//   字段,空对象已足)。
// - beforeEach 用 vi.resetModules() 让 registry 的 `initialized` 标志位
//   和 module-level 状态回到初始值,保证每个测试都从空 registry 出发;
//   首次进路由会触发 initCommands → registerBuiltinCommands,自动把
//   handoff builtin 命令塞进 registry。
// - 第二个测试用「克隆 handoff + 替换 getPromptForCommand」注入一个
//   抛错的命令,验证 try/catch 把它转成 {type:'error',payload:{message}}。

import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Command } from '@zn-ai/zn-agent-core'

// 路由的 `getRuntime() as ... | null` 调用在 runtime 未初始化时会 throw
// (agentRuntime.ts:411-414),先 mock 成空对象让路由不抛,聚焦 prompt 分支
// 的 try/catch 行为。
vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getRuntime: () => ({ config: {} }),
  getCurrentSessionId: () => null,
  resolveSkillPrompt: async () => null,
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

beforeEach(() => {
  // 重置 module 缓存 → `services/commands/registry.ts` 的 `initialized`
  // 标志位回到 false,`registerBuiltinCommands()` 在每个测试首次进路由
  // 时都会重新注册 clear/compact/status/handoff 这 4 条 builtin 命令。
  // 不用显式调 setCommandRegistry(null):下个测试 import 进来的
  // getCommandRegistry() 会得到新的 InMemoryRegistry 单例。
  vi.resetModules()
})

describe('POST /agent/command (handoff prompt branch)', () => {
  it('handoff 成功时返回 {type:prompt, payload:{rendered: 非空}}', async () => {
    const router = await loadRouter()
    const app = buildApp(router)

    // initCommands 内部会跑 registerBuiltinCommands,首次访问时
    // 触发 handoff 注入到 registry(空 args + 空 cwd 走 pickup 分支
    // 0-files,返回"未找到"提示,text 非空,正符合断言)。
    const res = await request(app)
      .post('/agent/command')
      .send({ name: 'handoff', args: '' })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('prompt')
    expect(typeof res.body.payload?.rendered).toBe('string')
    expect(res.body.payload.rendered.length).toBeGreaterThan(0)
  })

  it('handoff handler 抛错时返回 {type:error, payload:{message: 生成交接提示失败:...}}', async () => {
    const router = await loadRouter()
    const app = buildApp(router)

    // 预热一次,让 registerBuiltinCommands 跑完,registry 里有 handoff
    // 可被克隆(走 success 路径,顺带把 initCommands 的副作用 cache 住,
    // 下面的 register 不会因为 init 标志位 false 走空分支)。
    const warmup = await request(app)
      .post('/agent/command')
      .send({ name: 'handoff', args: '' })
    expect(warmup.body.type).toBe('prompt')

    // 注入一个抛错的 handoff 替身。registry 是 module singleton,
    // module 已被 reset 过,新 getCommandRegistry() 实例上的
    // `handoff` 就是 builtin 那个,可以放心 clone 字段。
    const { getCommandRegistry } = await import('@zn-ai/zn-agent-core')
    const reg = getCommandRegistry()
    const original = reg.get('handoff') as Command | undefined
    expect(original, 'precondition: handoff builtin must be registered').toBeDefined()
    const throwing: Command = {
      ...(original as Command),
      getPromptForCommand: async () => {
        throw new Error('boom')
      },
    } as Command
    reg.register(throwing)

    try {
      const res = await request(app)
        .post('/agent/command')
        .send({ name: 'handoff', args: '' })

      expect(res.status).toBe(200)
      expect(res.body.type).toBe('error')
      expect(res.body.payload?.message).toContain('生成交接提示失败')
      expect(res.body.payload?.message).toContain('boom')
    } finally {
      // 还原:不留下 throwing 替身,避免污染后续 test run 的 registry
      // (singleton 跨 test 文件共享)。
      if (original) reg.register(original)
    }
  })
})
