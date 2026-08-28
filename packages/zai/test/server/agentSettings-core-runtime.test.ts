import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Express } from 'express'

// zai patch (2026-08-28): coreRuntime 三态开关(settings 抽屉)。
// 覆盖 PUT 持久化(扁平字段)与 GET 归一化回显。
let dataDir: string
let app: Express

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-coreruntime-'))
  process.env.ZAI_DATA_DIR = dataDir
  process.env.HOME = dataDir
  delete process.env.ZAI_CORE_RUNTIME
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

describe('PUT /api/agent/settings/core-runtime', () => {
  it("persists 'inproc' to settings.coreRuntime", async () => {
    const res = await request(app)
      .put('/api/agent/settings/core-runtime')
      .send({ coreRuntime: 'inproc' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ coreRuntime: 'inproc' })
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.coreRuntime).toBe('inproc')
  })

  it("persists 'spawn' and preserves other top-level keys", async () => {
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
      .put('/api/agent/settings/core-runtime')
      .send({ coreRuntime: 'spawn' })
    expect(res.status).toBe(200)
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.coreRuntime).toBe('spawn')
    expect(onDisk.theme).toBe('dark')
    expect(onDisk.model).toBe('x')
  })

  it("persists 'default' as the literal string (无布尔二次转换)", async () => {
    await request(app)
      .put('/api/agent/settings/core-runtime')
      .send({ coreRuntime: 'inproc' })
    const res = await request(app)
      .put('/api/agent/settings/core-runtime')
      .send({ coreRuntime: 'default' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ coreRuntime: 'default' })
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.coreRuntime).toBe('default')
  })

  it('rejects unknown values with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/core-runtime')
      .send({ coreRuntime: 'print' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid coreRuntime/)
  })
})

describe('GET /api/agent/settings returns coreRuntime', () => {
  it("collapses legacy nested runtime.openccCli to 'default' (硬切,不读旧字段)", async () => {
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
    expect(res.body.coreRuntime).toBe('default')
  })

  it("defaults to 'default' when unset", async () => {
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.coreRuntime).toBe('default')
  })

  it('round-trips after PUT inproc', async () => {
    await request(app)
      .put('/api/agent/settings/core-runtime')
      .send({ coreRuntime: 'inproc' })
    const res = await request(app).get('/api/agent/settings')
    expect(res.body.coreRuntime).toBe('inproc')
  })
})
