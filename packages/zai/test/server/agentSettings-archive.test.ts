import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Express } from 'express'

// 把 ZAI_DATA_DIR / HOME 隔离到一个临时目录, 避免污染真实 ~/.zai/settings.json
let dataDir: string
let app: Express

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-archive-settings-'))
  process.env.ZAI_DATA_DIR = dataDir
  process.env.HOME = dataDir
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

function onDisk(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
  )
}

describe('GET /api/agent/settings exposes archiveKeepCount', () => {
  it('defaults to 20 when settings carry no archive block', async () => {
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.archiveKeepCount).toBe(20)
  })

  it('reflects a persisted value', async () => {
    await request(app)
      .put('/api/agent/settings/archive-keep-count')
      .send({ value: 5 })
    const res = await request(app).get('/api/agent/settings')
    expect(res.body.archiveKeepCount).toBe(5)
  })
})

describe('PUT /api/agent/settings/archive-keep-count', () => {
  it('persists value to archive.keepCount and echoes back', async () => {
    const res = await request(app)
      .put('/api/agent/settings/archive-keep-count')
      .send({ value: 50 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 50 })
    expect(onDisk().archive).toEqual({ keepCount: 50 })
  })

  it('preserves sibling keys inside the archive block', async () => {
    // updateZaiSettings 是浅合并({...settings, ...patch}),所以写 archive 块
    // 必须先读出现值再展开 —— 否则会把同级字段整个抹掉。这条是那个坑的回归测试
    // (对齐 agentSettings-memory.test.ts 的 sibling key 先例)。
    mkdirSync(join(dataDir, '.zai'), { recursive: true })
    writeFileSync(
      join(dataDir, '.zai', 'settings.json'),
      JSON.stringify({ archive: { keepCount: 5, someFutureKey: true } }),
    )
    const { __resetCacheForTests } = await import(
      '../../src/server/services/zaiSettingsCache.js'
    )
    __resetCacheForTests()
    const res = await request(app)
      .put('/api/agent/settings/archive-keep-count')
      .send({ value: 50 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 50 })
    expect(onDisk().archive).toEqual({
      keepCount: 50,
      someFutureKey: true,
    })
  })

  it('clamps below 1 to 1', async () => {
    const res = await request(app)
      .put('/api/agent/settings/archive-keep-count')
      .send({ value: 0 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 1 })
  })

  it('clamps above 1000 to 1000', async () => {
    const res = await request(app)
      .put('/api/agent/settings/archive-keep-count')
      .send({ value: 1e9 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 1000 })
  })

  it('rejects non-numeric payload with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/archive-keep-count')
      .send({ value: 'abc' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid archive\.keepCount/)
  })

  it('rejects a missing value with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/archive-keep-count')
      .send({})
    expect(res.status).toBe(400)
  })
})
