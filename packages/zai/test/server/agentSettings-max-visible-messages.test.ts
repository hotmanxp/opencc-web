import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Express } from 'express'

// 把 ZAI_DATA_DIR / HOME 隔离到一个临时目录, 避免污染真实 ~/.zai/settings.json
let dataDir: string
let app: Express

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-max-visible-'))
  process.env.ZAI_DATA_DIR = dataDir
  process.env.HOME = dataDir
  vi.resetModules()
  // 重置 in-process cache + 重新 import router, 让每个 test 拿到全新模块实例
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

describe('PUT /api/agent/settings/max-visible-messages', () => {
  it('persists value to settings.json and echoes back', async () => {
    const res = await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: 50 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 50 })
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.maxVisibleMessages).toBe(50)
  })

  it('clamps value below 1 to 1', async () => {
    const res = await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: -10 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 1 })
  })

  it('clamps value above 1000 to 1000', async () => {
    const res = await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: 99999 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 1000 })
  })

  it('rejects non-number value with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: 'fifty' })
    expect(res.status).toBe(400)
  })

  it('rounds down fractional input', async () => {
    const res = await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: 12.7 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: 12 })
  })
})

describe('GET /api/agent/settings returns maxVisibleMessages', () => {
  it('returns persisted maxVisibleMessages', async () => {
    await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: 75 })
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.maxVisibleMessages).toBe(75)
  })

  it('returns default 20 when settings.json has no maxVisibleMessages', async () => {
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.maxVisibleMessages).toBe(20)
  })
})