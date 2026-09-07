import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Express } from 'express'

// zai patch (2026-08-28 命名统一,2026-08-30 全部统一为 `runtimeCore` 字段):
// runtimeCore 四态开关(settings 抽屉)。覆盖 PUT 持久化(扁平字段)与
// GET 归一化回显。
let dataDir: string
let app: Express

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-runtimecore-'))
  process.env.ZAI_DATA_DIR = dataDir
  process.env.HOME = dataDir
  delete process.env.ZAI_RUNTIME_CORE
  vi.resetModules()
  const { __resetCacheForTests } = await import(
    '../../src/server/services/zaiSettingsCache.js'
  )
  __resetCacheForTests()
  const { default: agentSettingsRouter } = await import(
    '../../src/server/routes/agentSettings.js'
  )
  app = express()
  app.use(express.json())
  app.locals.instanceContext = { cwd: '/tmp', cwdName: 'test' }
  app.use('/api', agentSettingsRouter)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('PUT /api/agent/settings/runtime-core', () => {
  it("persists 'repl' to settings.runtimeCore", async () => {
    const res = await request(app)
      .put('/api/agent/settings/runtime-core')
      .send({ runtimeCore: 'repl' })
    expect(res.status).toBe(200)
    // PUT response also returns `activeRuntimeCore`(zai patch 2026-08-30): the
    // runtime-resolved value, distinct from persisted `runtimeCore`. Tests
    // assert the persisted value of interest; `activeRuntimeCore` is read
    // here as a side info field, its value depends on agentRuntime init
    // which is not exercised by this isolated router test.
    expect(res.body.runtimeCore).toBe('repl')
    expect(res.body).toHaveProperty('activeRuntimeCore')
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.runtimeCore).toBe('repl')
  })

  it("persists 'default' and preserves other top-level keys", async () => {
    mkdirSync(join(dataDir, '.zai'), { recursive: true })
    writeFileSync(
      join(dataDir, '.zai', 'settings.json'),
      JSON.stringify({ theme: 'dark', model: 'x' }),
    )
    const { __resetCacheForTests } = await import(
      '../../src/server/services/zaiSettingsCache.js'
    )
    __resetCacheForTests()
    const res = await request(app)
      .put('/api/agent/settings/runtime-core')
      .send({ runtimeCore: 'default' })
    expect(res.status).toBe(200)
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.runtimeCore).toBe('default')
    expect(onDisk.theme).toBe('dark')
    expect(onDisk.model).toBe('x')
  })

  it.each(['inproc', 'spawn', 'print'] as const)(
    "rejects legacy/unknown '%s' with 400 and does not persist",
    async (v) => {
      const res = await request(app)
        .put('/api/agent/settings/runtime-core')
        .send({ runtimeCore: v })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/invalid runtimeCore/)
      // 400 时设置不落盘:settings.json 要么不存在,要么不含 runtimeCore
      const settingsPath = join(dataDir, '.zai', 'settings.json')
      if (existsSync(settingsPath)) {
        const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8'))
        expect(onDisk.runtimeCore).toBeUndefined()
      }
    },
  )
})

describe('GET /api/agent/settings returns runtimeCore', () => {
  it("collapses legacy nested runtime.openccCli to 'repl' (硬切,不读旧字段)", async () => {
    mkdirSync(join(dataDir, '.zai'), { recursive: true })
    writeFileSync(
      join(dataDir, '.zai', 'settings.json'),
      JSON.stringify({ runtime: { openccCli: 'inproc' } }),
    )
    const { __resetCacheForTests } = await import(
      '../../src/server/services/zaiSettingsCache.js'
    )
    __resetCacheForTests()
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    // zai patch (2026-08-30): 缺失 / 非法 → 'repl'(spec §5.1 把默认从
    // 'default' 翻为 'repl')。
    expect(res.body.runtimeCore).toBe('repl')
  })

  it("defaults to 'repl' when unset", async () => {
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.runtimeCore).toBe('repl')
  })

  it('round-trips after PUT repl', async () => {
    await request(app)
      .put('/api/agent/settings/runtime-core')
      .send({ runtimeCore: 'repl' })
    const res = await request(app).get('/api/agent/settings')
    expect(res.body.runtimeCore).toBe('repl')
  })
})
