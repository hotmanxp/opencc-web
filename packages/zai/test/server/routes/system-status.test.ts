import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import systemRouter from '../../../src/server/routes/system.js'
import { writeManagedState } from '../../../src/cli/managedState.js'
import { rm } from 'node:fs/promises'

const TEST_DIR = '/tmp/zai-test-system-status'

afterEach(async () => {
  delete process.env.ZAI_SUPERVISOR_PID
  delete process.env.ZAI_INSTANCE_ID
  delete process.env.ZAI_DATA_DIR
  try { await rm(TEST_DIR, { recursive: true, force: true }) } catch {}
})

describe('GET /api/system/status', () => {
  it('returns 404 when not managed', async () => {
    delete process.env.ZAI_SUPERVISOR_PID
    const app = express()
    app.use('/api', systemRouter)
    const res = await request(app).get('/api/system/status')
    expect(res.status).toBe(404)
  })

  it('returns 200 with state unknown when managed but file missing', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    process.env.ZAI_DATA_DIR = TEST_DIR
    const app = express()
    app.use('/api', systemRouter)
    const res = await request(app).get('/api/system/status')
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('unknown')
    expect(res.body.childPid).toBeNull()
    expect(res.body.restarts).toBe(0)
  })

  it('returns 200 with parsed managed.json content', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    process.env.ZAI_DATA_DIR = TEST_DIR
    await writeManagedState({
      supervisorPid: 9999,
      state: 'running',
      childPid: 12345,
      startedAt: '2026-08-01T00:00:00.000Z',
      restarts: 3,
      lastError: null,
    }, TEST_DIR)

    const app = express()
    app.use('/api', systemRouter)
    const res = await request(app).get('/api/system/status')
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('running')
    expect(res.body.childPid).toBe(12345)
    expect(res.body.restarts).toBe(3)
    expect(res.body.startedAt).toBe('2026-08-01T00:00:00.000Z')
    expect(res.body.lastError).toBeNull()
  })
})

describe('GET /api/system supervisor 关系字段', () => {
  // routes/system.ts 的 GET /api/system 读 req.app.locals.instanceContext,
  // 这里在测试里手动塞,模拟 createApp() 的初始化。
  function bootApp(): express.Express {
    const app = express()
    app.locals.instanceContext = {
      cwd: '/tmp/x',
      cwdName: 'x',
      host: '127.0.0.1',
    }
    app.use('/api', systemRouter)
    return app
  }

  // 顶层独立 zai-server:isManagedChild=false, supervisorPid/instanceId 都 null
  it('独立 zai-server:isManagedChild=false,supervisorPid/instanceId=null', async () => {
    delete process.env.ZAI_SUPERVISOR_PID
    delete process.env.ZAI_INSTANCE_ID
    const res = await request(bootApp()).get('/api/system')
    expect(res.status).toBe(200)
    expect(res.body.isManagedChild).toBe(false)
    expect(res.body.supervisorPid).toBeNull()
    expect(res.body.instanceId).toBeNull()
  })

  // 顶层 managed child:有 ZAI_SUPERVISOR_PID,没有 ZAI_INSTANCE_ID
  it('顶层 managed child:ZAI_SUPERVISOR_PID 已设,isManagedChild=true,instanceId=null', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    delete process.env.ZAI_INSTANCE_ID
    const res = await request(bootApp()).get('/api/system')
    expect(res.status).toBe(200)
    expect(res.body.isManagedChild).toBe(true)
    expect(res.body.supervisorPid).toBe(9999)
    expect(res.body.instanceId).toBeNull()
  })

  // instance 子实例:两个 env 都设了
  it('instance 子实例:env 都有,字段全显', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    process.env.ZAI_INSTANCE_ID = 'inst_abc'
    const res = await request(bootApp()).get('/api/system')
    expect(res.status).toBe(200)
    expect(res.body.isManagedChild).toBe(true)
    expect(res.body.supervisorPid).toBe(9999)
    expect(res.body.instanceId).toBe('inst_abc')
  })
})
