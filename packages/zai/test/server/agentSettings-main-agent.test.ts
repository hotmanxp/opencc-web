import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Express } from 'express'

// 隔离 HOME / ZAI_DATA_DIR 到临时目录,避免污染真实 ~/.zai/settings.json
// 与 ~/.zai/main-agents(theme 测试同款模式)。
let dataDir: string
let app: Express

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-main-agent-'))
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

describe('GET /api/agent/settings — mainAgent fields', () => {
  it('returns default mainAgent + builtin mainAgents list', async () => {
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.mainAgent).toBe('default')
    const names = (res.body.mainAgents as Array<{ name: string }>).map(
      (a) => a.name,
    )
    expect(names).toContain('default')
    expect(names).toContain('office')
  })

  it('returns persisted mainAgent selection', async () => {
    await request(app)
      .put('/api/agent/settings/main-agent')
      .send({ mainAgent: 'office' })
    const res = await request(app).get('/api/agent/settings')
    expect(res.body.mainAgent).toBe('office')
  })
})

describe('PUT /api/agent/settings/main-agent', () => {
  it('persists office and echoes back', async () => {
    const res = await request(app)
      .put('/api/agent/settings/main-agent')
      .send({ mainAgent: 'office' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ mainAgent: 'office' })
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.mainAgent).toBe('office')
  })

  it('rejects unknown agent with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/main-agent')
      .send({ mainAgent: 'nope' })
    expect(res.status).toBe(400)
  })

  it('rejects missing / empty field with 400', async () => {
    const empty = await request(app)
      .put('/api/agent/settings/main-agent')
      .send({})
    expect(empty.status).toBe(400)
    const blank = await request(app)
      .put('/api/agent/settings/main-agent')
      .send({ mainAgent: '' })
    expect(blank.status).toBe(400)
  })
})
