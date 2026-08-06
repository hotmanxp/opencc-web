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
  dataDir = mkdtempSync(join(tmpdir(), 'zai-default-split-screen-'))
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

describe('PUT /api/agent/settings/default-split-screen', () => {
  it('persists true to settings.json and echoes back', async () => {
    const res = await request(app)
      .put('/api/agent/settings/default-split-screen')
      .send({ value: true })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: true })
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.defaultSplitScreen).toBe(true)
  })

  it('persists false to settings.json and echoes back', async () => {
    // 先写 true, 再回退到 false, 确认双向切换落盘正确
    await request(app)
      .put('/api/agent/settings/default-split-screen')
      .send({ value: true })
    const res = await request(app)
      .put('/api/agent/settings/default-split-screen')
      .send({ value: false })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: false })
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.defaultSplitScreen).toBe(false)
  })

  it('rejects non-boolean payload with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/default-split-screen')
      .send({ value: 'yes' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid defaultSplitScreen/)
  })

  it('rejects missing value field with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/default-split-screen')
      .send({})
    expect(res.status).toBe(400)
  })

  it('preserves unrelated settings fields when persisting', async () => {
    // 先写入 outputStyle, 再切 defaultSplitScreen, 确认 outputStyle 不被覆盖
    await request(app)
      .put('/api/agent/settings/output-style')
      .send({ outputStyle: 'compact' })
    await request(app)
      .put('/api/agent/settings/default-split-screen')
      .send({ value: true })
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.outputStyle).toBe('compact')
    expect(onDisk.defaultSplitScreen).toBe(true)
  })
})

describe('GET /api/agent/settings returns defaultSplitScreen', () => {
  it('returns true after persisting', async () => {
    await request(app)
      .put('/api/agent/settings/default-split-screen')
      .send({ value: true })
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.defaultSplitScreen).toBe(true)
  })

  it('defaults to false when settings.json has no defaultSplitScreen', async () => {
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.defaultSplitScreen).toBe(false)
  })

  it('coerces non-boolean junk in settings.json to false', async () => {
    // 直接写脏数据到磁盘 (模拟用户手编 settings.json 写错), 服务端必须折叠
    const settingsPath = join(dataDir, '.zai', 'settings.json')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dataDir, '.zai'), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ defaultSplitScreen: 'yes' }))
    const { __resetCacheForTests } = await import(
      '../../src/server/services/zaiSettingsCache.js'
    )
    __resetCacheForTests()
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.defaultSplitScreen).toBe(false)
  })
})