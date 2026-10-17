import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import supertest from 'supertest'
import { CLI_AGENT_NAMES } from '@shared/cliAgents'

// ~/.zai/settings.json 读写走内存替身 —— 测试绝不碰真实用户 settings.json。
const h = vi.hoisted(() => ({
  settings: {
    theme: 'dark',
    subagents: { existingProvider: { enabled: false } },
  } as Record<string, unknown>,
}))

vi.mock('../../../src/server/services/zaiSettingsStore.js', () => ({
  readZaiSettings: async () => h.settings,
  updateZaiSettings: async (patch: Record<string, unknown>) => {
    h.settings = { ...h.settings, ...patch }
    return h.settings
  },
}))

// 运行时 registry active 状态替身:opencc 视为已注册(claude-code provider
// 无条件注册的等价场景),dsh 未注册。
vi.mock('@zn-ai/zn-agent-core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@zn-ai/zn-agent-core')>()
  return {
    ...mod,
    getSubagentRegistry: () => ({ list: () => ['opencc'] }),
  }
})

import superTasksRouter from '../../../src/server/routes/superTasks.js'
import {
  __resetForTests as resetFactorySettings,
} from '../../../src/server/services/factorySettings.js'
import { __resetForTests as resetBridge } from '../../../src/server/services/taskFactoryBridge.js'

let dataDir: string
let tfDir: string
let app: express.Express

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fs-routes-data-'))
  tfDir = await mkdtemp(join(tmpdir(), 'fs-routes-tf-'))
  process.env.ZAI_DATA_DIR = dataDir
  process.env.ZAI_TASK_FACTORY_DIR = tfDir
  resetBridge()
  app = express()
  app.use(express.json())
  app.use('/api', superTasksRouter)
})

afterAll(async () => {
  delete process.env.ZAI_DATA_DIR
  delete process.env.ZAI_TASK_FACTORY_DIR
  await rm(dataDir, { recursive: true, force: true })
  await rm(tfDir, { recursive: true, force: true })
})

beforeEach(() => {
  resetFactorySettings()
  h.settings = {
    theme: 'dark',
    subagents: { existingProvider: { enabled: false } },
  }
})

describe('GET /api/super-tasks/settings', () => {
  it('文件缺失 → 默认值 + docsDirExists=false', async () => {
    const res = await supertest(app).get('/api/super-tasks/settings')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      docsDir: '',
      repoRoot: '',
      maxParallelTasks: 4,
      preferCliAgent: null,
      historyArchiveHours: 48,
      docsDirExists: false,
      repoRootExists: false,
    })
  })

  it('PUT 后 GET 保持,目录存在性徽标为 true', async () => {
    const put = await supertest(app)
      .put('/api/super-tasks/settings')
      .send({ docsDir: dataDir, repoRoot: '/no/such/dir', maxParallelTasks: 6 })
    expect(put.status).toBe(200)
    const res = await supertest(app).get('/api/super-tasks/settings')
    expect(res.body.docsDir).toBe(dataDir)
    expect(res.body.maxParallelTasks).toBe(6)
    expect(res.body.docsDirExists).toBe(true)
    expect(res.body.repoRootExists).toBe(false)
  })
})

describe('PUT /api/super-tasks/settings', () => {
  it('合法 partial patch 合并成功', async () => {
    const r1 = await supertest(app).put('/api/super-tasks/settings').send({ preferCliAgent: 'dsh' })
    expect(r1.status).toBe(200)
    const r2 = await supertest(app).put('/api/super-tasks/settings').send({ repoRoot: dataDir })
    expect(r2.status).toBe(200)
    expect(r2.body.preferCliAgent).toBe('dsh')
    expect(r2.body.repoRoot).toBe(dataDir)
  })

  it('maxParallelTasks 1/9/非整数 → 400', async () => {
    for (const bad of [1, 9, 3.5]) {
      const res = await supertest(app).put('/api/super-tasks/settings').send({ maxParallelTasks: bad })
      expect(res.status).toBe(400)
    }
  })

  it('historyArchiveHours 0/8761/非整数 → 400;合法值 PUT→GET 持久化', async () => {
    for (const bad of [0, 8761, 2.5]) {
      const res = await supertest(app).put('/api/super-tasks/settings').send({ historyArchiveHours: bad })
      expect(res.status).toBe(400)
    }
    const ok = await supertest(app).put('/api/super-tasks/settings').send({ historyArchiveHours: 72 })
    expect(ok.status).toBe(200)
    expect(ok.body.historyArchiveHours).toBe(72)
    const res = await supertest(app).get('/api/super-tasks/settings')
    expect(res.body.historyArchiveHours).toBe(72)
  })

  it('非法枚举 / 非字符串路径 → 400', async () => {
    const r1 = await supertest(app).put('/api/super-tasks/settings').send({ preferCliAgent: 'codex' })
    expect(r1.status).toBe(400)
    const r2 = await supertest(app).put('/api/super-tasks/settings').send({ docsDir: 42 })
    expect(r2.status).toBe(400)
  })

  // oc-002 回归:`7c32e4da` 把 claude 加进了 UI 提供的 provider 名单,
  // 却没加进这里落盘校验的 zod 枚举 —— 于是 UI 能选、服务端 400。
  // 断言「名单里的每个值都必须被接受」,而不是逐个手写:以后加 provider
  // 这条会自己跟上,漏一处就红。
  it.each([...CLI_AGENT_NAMES])('preferCliAgent=%s → 200 且往返一致', async (name) => {
    const put = await supertest(app)
      .put('/api/super-tasks/settings')
      .send({ preferCliAgent: name })
    expect(put.status).toBe(200)
    const got = await supertest(app).get('/api/super-tasks/settings')
    expect(got.status).toBe(200)
    expect(got.body.preferCliAgent).toBe(name)
  })

  it('claude 可选:UI options 不会因 schema 拒绝而给出选了必 400 的值', async () => {
    // UI 的 options 来自 /spawn-agents 的 agents 数组,服务端校验来自 zod。
    // 两者现在同源于 CLI_AGENT_NAMES,所以 UI 给出的每个名字都必然被接受 ——
    // 断言「UI 报的 name 集合 ⊆ 服务端接受的集合」。
    const agents = (await supertest(app).get('/api/super-tasks/spawn-agents')).body
      .agents as Array<{ name: string }>
    for (const a of agents) {
      const r = await supertest(app).put('/api/super-tasks/settings').send({ preferCliAgent: a.name })
      expect(r.status, `UI 提供了 ${a.name} 但服务端拒绝`).toBe(200)
    }
  })

  it('非法值不落盘:GET 仍是旧值', async () => {
    await supertest(app).put('/api/super-tasks/settings').send({ maxParallelTasks: 5 })
    const bad = await supertest(app).put('/api/super-tasks/settings').send({ maxParallelTasks: 99 })
    expect(bad.status).toBe(400)
    const res = await supertest(app).get('/api/super-tasks/settings')
    expect(res.body.maxParallelTasks).toBe(5)
  })
})

describe('GET /api/super-tasks/spawn-agents', () => {
  it('返回 CLI_AGENT_NAMES 里每个 provider 的状态快照', async () => {
    const res = await supertest(app).get('/api/super-tasks/spawn-agents')
    expect(res.status).toBe(200)
    const agents = res.body.agents as Array<Record<string, unknown>>
    // zai patch (2026-10-17, oc-002):原先这里硬写
    // `toEqual(['opencc', 'dsh', 'opencode'])` —— `7c32e4da` 加 `claude` 时
    // 没同步,这条测试从那天起一直是红的,而且之后 6 个 commit 没人跑过它
    // (AGENTS.md 要求跑直接受影响的文件,superTasks.ts 正是)。改为跟着真相源走,
    // 以后加 provider 不会再漂。
    expect(agents.map((a) => a.name)).toEqual([...CLI_AGENT_NAMES])
    const byName = (n: string) => agents.find((a) => a.name === n)!

    const opencc = byName('opencc')
    expect(typeof opencc.commandFound).toBe('boolean')
    expect(opencc.commandPath === null || typeof opencc.commandPath === 'string').toBe(true)
    expect(opencc.registered).toBe(false) // h.settings.subagents 无 opencc 块
    expect(opencc.active).toBe(true) // mock registry: ['opencc']

    expect(byName('dsh').registered).toBe(false)
    expect(byName('dsh').active).toBe(false)
    // opencode: config-gated like dsh → not active under the mock registry.
    expect(byName('opencode').registered).toBe(false)
    expect(byName('opencode').active).toBe(false)
    // claude(7c32e4da 新增):config-gated 同 dsh/opencode
    expect(byName('claude').registered).toBe(false)
    expect(byName('claude').active).toBe(false)
  })

  it('settings.json 已有 subagents.<name> → registered=true', async () => {
    h.settings = { ...h.settings, subagents: { dsh: { enabled: true } } }
    const res = await supertest(app).get('/api/super-tasks/spawn-agents')
    const dsh = (res.body.agents as Array<Record<string, unknown>>).find((a) => a.name === 'dsh')
    expect(dsh?.registered).toBe(true)
  })

  it('subagents.opencode 配置块 → opencode registered=true', async () => {
    h.settings = { ...h.settings, subagents: { opencode: { enabled: true } } }
    const res = await supertest(app).get('/api/super-tasks/spawn-agents')
    const opencode = (res.body.agents as Array<Record<string, unknown>>).find(
      (a) => a.name === 'opencode',
    )
    expect(opencode?.registered).toBe(true)
  })
})

describe('POST /api/super-tasks/spawn-agents/:name/register', () => {
  it('merge 写 subagents.dsh,不破坏 settings.json 其它键', async () => {
    const res = await supertest(app).post('/api/super-tasks/spawn-agents/dsh/register')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, restartRequired: true })
    expect(h.settings.theme).toBe('dark') // 其它键原样
    const subs = h.settings.subagents as Record<string, unknown>
    expect(subs.existingProvider).toEqual({ enabled: false }) // 其它 provider 块原样
    expect(subs.dsh).toEqual({ enabled: true })
  })

  it('已存在配置块 → 保留其它字段,仅置 enabled:true', async () => {
    h.settings = { ...h.settings, subagents: { opencc: { command: 'opencc', enabled: false } } }
    const res = await supertest(app).post('/api/super-tasks/spawn-agents/opencc/register')
    expect(res.status).toBe(200)
    expect((h.settings.subagents as Record<string, unknown>).opencc).toEqual({
      command: 'opencc',
      enabled: true,
    })
  })

  it('merge 写 subagents.opencode(enabled:true)', async () => {
    const res = await supertest(app).post('/api/super-tasks/spawn-agents/opencode/register')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, restartRequired: true })
    const subs = h.settings.subagents as Record<string, unknown>
    expect(subs.existingProvider).toEqual({ enabled: false }) // 其它块原样
    expect(subs.opencode).toEqual({ enabled: true })
  })

  it('非白名单 name → 404', async () => {
    const res = await supertest(app).post('/api/super-tasks/spawn-agents/codex/register')
    expect(res.status).toBe(404)
  })
})
