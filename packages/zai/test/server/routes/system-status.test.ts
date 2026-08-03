import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import systemRouter from '../../../src/server/routes/system.js'
import { writeManagedState } from '../../../src/cli/managedState.js'
import { rm } from 'node:fs/promises'

const TEST_DIR = '/tmp/zai-test-system-status'

afterEach(async () => {
  delete process.env.ZAI_SUPERVISOR_PID
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
