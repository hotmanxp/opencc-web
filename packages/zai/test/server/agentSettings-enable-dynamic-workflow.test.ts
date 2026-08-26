import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  dataDir = mkdtempSync(join(tmpdir(), 'zai-enable-workflow-'))
  process.env.ZAI_DATA_DIR = dataDir
  process.env.HOME = dataDir
  // 清掉 OPENCC_ENABLE_WORKFLOWS, 确保每个 test 起始状态干净
  delete process.env.OPENCC_ENABLE_WORKFLOWS
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
  delete process.env.OPENCC_ENABLE_WORKFLOWS
})

describe('PUT /api/agent/settings/enable-dynamic-workflow', () => {
  it('persists true to settings.json and sets OPENCC_ENABLE_WORKFLOWS=1', async () => {
    const res = await request(app)
      .put('/api/agent/settings/enable-dynamic-workflow')
      .send({ value: true })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: true })
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.enableDynamicWorkflow).toBe(true)
    // 关键: PUT true 必须同步写 process.env,下次 query() 才能立刻
    // 把 WorkflowTool 加进工具池 — 不需要重启进程。
    expect(process.env.OPENCC_ENABLE_WORKFLOWS).toBe('1')
  })

  it('persists false and clears OPENCC_ENABLE_WORKFLOWS', async () => {
    // 先打开, 再关闭, 确认双向切换都对
    await request(app)
      .put('/api/agent/settings/enable-dynamic-workflow')
      .send({ value: true })
    expect(process.env.OPENCC_ENABLE_WORKFLOWS).toBe('1')
    const res = await request(app)
      .put('/api/agent/settings/enable-dynamic-workflow')
      .send({ value: false })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ value: false })
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.enableDynamicWorkflow).toBe(false)
    // 关键: 关闭时必须 delete env var, 否则 isWorkflowsDisabled() 仍
    // 会从 env var 短路返回 false (workflows enabled), WorkflowTool
    // 会继续出现在工具池里 — 这是用户感知到的"toggle 没生效"。
    expect(process.env.OPENCC_ENABLE_WORKFLOWS).toBeUndefined()
  })

  it('rejects non-boolean payload with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/enable-dynamic-workflow')
      .send({ value: 'yes' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid enableDynamicWorkflow/)
  })

  it('rejects missing value field with 400', async () => {
    const res = await request(app)
      .put('/api/agent/settings/enable-dynamic-workflow')
      .send({})
    expect(res.status).toBe(400)
  })

  it('preserves unrelated settings fields when persisting', async () => {
    await request(app)
      .put('/api/agent/settings/output-style')
      .send({ outputStyle: 'compact' })
    await request(app)
      .put('/api/agent/settings/enable-dynamic-workflow')
      .send({ value: true })
    const onDisk = JSON.parse(
      readFileSync(join(dataDir, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(onDisk.outputStyle).toBe('compact')
    expect(onDisk.enableDynamicWorkflow).toBe(true)
  })
})

describe('GET /api/agent/settings returns enableDynamicWorkflow', () => {
  it('returns true after persisting', async () => {
    await request(app)
      .put('/api/agent/settings/enable-dynamic-workflow')
      .send({ value: true })
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.enableDynamicWorkflow).toBe(true)
  })

  it('defaults to false when settings.json has no enableDynamicWorkflow', async () => {
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.enableDynamicWorkflow).toBe(false)
  })

  it('coerces non-boolean junk in settings.json to false', async () => {
    // 模拟用户手编 settings.json 写错 (e.g. enableDynamicWorkflow: "yes"),
    // 服务端必须折叠为 false — 否则 LLM 可能看到 WorkflowTool 而 UI 显示关闭
    const settingsPath = join(dataDir, '.zai', 'settings.json')
    mkdirSync(join(dataDir, '.zai'), { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify({ enableDynamicWorkflow: 'yes' }),
    )
    const { __resetCacheForTests } = await import(
      '../../src/server/services/zaiSettingsCache.js'
    )
    __resetCacheForTests()
    const res = await request(app).get('/api/agent/settings')
    expect(res.status).toBe(200)
    expect(res.body.enableDynamicWorkflow).toBe(false)
  })
})
