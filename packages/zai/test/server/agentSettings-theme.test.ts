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
  dataDir = mkdtempSync(join(tmpdir(), 'zai-theme-'))
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

describe('PUT /api/agent/settings/theme', () => {
  it('persists dark theme and echoes back', async () => {
    const res = await request(app)
      .put('/api/agent/settings/theme')
      .send({ theme: 'dark' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ theme: 'dark' })
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.theme).toBe('dark')
  })

  it('persists high-contrast theme (4 档全支持)', async () => {
    const res = await request(app)
      .put('/api/agent/settings/theme')
      .send({ theme: 'high-contrast' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ theme: 'high-contrast' })
  })

  it('rejects invalid theme with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/theme')
      .send({ theme: 'rainbow' })
    expect(res.status).toBe(400)
  })

  it('rejects missing theme field with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/theme')
      .send({})
    expect(res.status).toBe(400)
  })

  it('preserves other settings fields (outputStyle + maxVisibleMessages)', async () => {
    // 先 PUT 一条 outputStyle + maxVisibleMessages
    await request(app)
      .put('/api/agent/settings/output-style')
      .send({ outputStyle: 'compact' })
    await request(app)
      .put('/api/agent/settings/max-visible-messages')
      .send({ value: 50 })
    // 再 PUT theme
    await request(app)
      .put('/api/agent/settings/theme')
      .send({ theme: 'light' })

    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.theme).toBe('light')
    expect(onDisk.outputStyle).toBe('compact')
    expect(onDisk.maxVisibleMessages).toBe(50)
  })
})

describe('GET /api/agent/settings returns theme', () => {
  it('returns persisted theme', async () => {
    await request(app)
      .put('/api/agent/settings/theme')
      .send({ theme: 'dark' })
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.theme).toBe('dark')
  })

  it('defaults to dark when settings.json has no theme', async () => {
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.theme).toBe('dark')
  })

  it('defaults to dark when settings.json theme is unknown (兜底)', async () => {
    // 直接写一个垃圾值到磁盘
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const dir = join(dataDir, '.zai')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ theme: 'rainbow' }),
      'utf-8',
    )
    // 重置 cache 让它重新读
    const { __resetCacheForTests } = await import(
      '../../src/server/services/zaiSettingsCache.js'
    )
    __resetCacheForTests()

    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.theme).toBe('dark')
  })
})