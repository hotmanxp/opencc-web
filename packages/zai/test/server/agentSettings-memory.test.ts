import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Express } from 'express'

// 把 ZAI_DATA_DIR / HOME 隔离到临时目录,避免污染真实 ~/.zai/settings.json
let dataDir: string
let app: Express

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-memory-settings-'))
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

describe('PUT /api/agent/settings/memory-auto-write', () => {
  it('persists false to memory.autoWrite', async () => {
    const res = await request(app)
      .put('/api/agent/settings/memory-auto-write')
      .send({ value: false })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: false })
    expect(onDisk().memory).toEqual({ autoWrite: false })
  })

  it('preserves the sibling requireApprovalBeforeWrite key', async () => {
    // updateZaiSettings 是浅合并({...settings, ...patch}),所以写 memory 块
    // 必须先读出现值再展开 —— 否则会把同级字段整个抹掉。这条是那个坑的回归测试。
    await request(app)
      .put('/api/agent/settings/memory-require-approval')
      .send({ value: false })
    const res = await request(app)
      .put('/api/agent/settings/memory-auto-write')
      .send({ value: false })
    expect(res.status).toBe(200)
    expect(onDisk().memory).toEqual({
      requireApprovalBeforeWrite: false,
      autoWrite: false,
    })
  })

  it('rejects non-boolean payload with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/memory-auto-write')
      .send({ value: 'yes' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid memory\.autoWrite/)
  })
})

describe('PUT /api/agent/settings/memory-require-approval', () => {
  it('persists the vendor-native meaning (true = still requires approval)', async () => {
    const res = await request(app)
      .put('/api/agent/settings/memory-require-approval')
      .send({ value: false })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: false })
    expect(onDisk().memory).toEqual({ requireApprovalBeforeWrite: false })
  })

  it('preserves the sibling autoWrite key', async () => {
    await request(app)
      .put('/api/agent/settings/memory-auto-write')
      .send({ value: true })
    const res = await request(app)
      .put('/api/agent/settings/memory-require-approval')
      .send({ value: false })
    expect(res.status).toBe(200)
    expect(onDisk().memory).toEqual({
      autoWrite: true,
      requireApprovalBeforeWrite: false,
    })
  })

  it('rejects missing value with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/memory-require-approval')
      .send({})
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/agent/settings/auto-dream', () => {
  it('persists the top-level autoDreamEnabled flag', async () => {
    const res = await request(app)
      .put('/api/agent/settings/auto-dream')
      .send({ value: true })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: true })
    expect(onDisk().autoDreamEnabled).toBe(true)
  })

  it('toggles back off', async () => {
    await request(app).put('/api/agent/settings/auto-dream').send({ value: true })
    const res = await request(app)
      .put('/api/agent/settings/auto-dream')
      .send({ value: false })
    expect(res.status).toBe(200)
    expect(onDisk().autoDreamEnabled).toBe(false)
  })

  it('rejects non-boolean payload with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/auto-dream')
      .send({ value: 1 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid autoDreamEnabled/)
  })
})

describe('GET /api/agent/settings exposes the memory trio', () => {
  it('defaults to enabled memory, approval required, dream off', async () => {
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    // 默认值必须与 vendor resolver 一致:记忆默认开、免审批默认关、固化默认关。
    expect(res.body.memoryAutoWrite).toBe(true)
    expect(res.body.memoryRequireApproval).toBe(true)
    expect(res.body.autoDreamEnabled).toBe(false)
  })

  it('reflects persisted values', async () => {
    await request(app)
      .put('/api/agent/settings/memory-auto-write')
      .send({ value: false })
    await request(app)
      .put('/api/agent/settings/memory-require-approval')
      .send({ value: false })
    await request(app).put('/api/agent/settings/auto-dream').send({ value: true })
    const res = await request(app).get('/api/agent/settings')
    expect(res.body.memoryAutoWrite).toBe(false)
    expect(res.body.memoryRequireApproval).toBe(false)
    expect(res.body.autoDreamEnabled).toBe(true)
  })

  it('coerces hand-edited junk to the safe defaults', async () => {
    // 手编 settings.json 写错类型时:autoWrite/requireApproval 折叠为"开/需审批"
    // (fail-safe),autoDream 折叠为关。
    mkdirSync(join(dataDir, '.zai'), { recursive: true })
    writeFileSync(
      join(dataDir, '.zai', 'settings.json'),
      JSON.stringify({
        memory: { autoWrite: 'no', requireApprovalBeforeWrite: 'nope' },
        autoDreamEnabled: 'yes',
      }),
    )
    const { __resetCacheForTests } = await import(
      '../../src/server/services/zaiSettingsCache.js'
    )
    __resetCacheForTests()
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.memoryAutoWrite).toBe(true)
    expect(res.body.memoryRequireApproval).toBe(true)
    expect(res.body.autoDreamEnabled).toBe(false)
  })
})