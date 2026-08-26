import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import systemRouter, { __resetRestartRouter } from '../../../src/server/routes/system.js'
import { eventBus } from '../../../src/server/services/eventBus.js'
import { __resetBackgroundRuntimeForTests } from '../../../src/server/services/backgroundRuntime.js'

afterEach(() => {
  delete process.env.ZAI_SUPERVISOR_PID
  __resetRestartRouter()
  __resetBackgroundRuntimeForTests()
})

describe('POST /api/system/stop', () => {
  beforeEach(() => {
    __resetRestartRouter()
    __resetBackgroundRuntimeForTests()
  })

  it('returns 409 when not managed', async () => {
    delete process.env.ZAI_SUPERVISOR_PID
    __resetRestartRouter()
    const app = express()
    app.use(express.json())
    app.use((req: any, _res, next) => {
      req._instanceContext = { cwd: '/', cwdName: 'x', host: '127.0.0.1' }
      next()
    })
    app.use('/api', systemRouter)
    const res = await request(app).post('/api/system/stop')
    expect(res.status).toBe(409)
    expect(res.body?.error).toBe('not_managed')
  })

  it('returns 202 when managed and emits system.stopping on the event bus', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    __resetRestartRouter()
    const seen: { type: string; deadlineMs?: number }[] = []
    const off = eventBus.subscribe((e) => {
      if (e.type === 'system.stopping') {
        seen.push({ type: e.type, deadlineMs: e.deadlineMs })
      }
    })
    try {
      const app = express()
      app.use(express.json())
      app.use((req: any, _res, next) => {
        req._instanceContext = { cwd: '/', cwdName: 'x', host: '127.0.0.1' }
        next()
      })
      app.use('/api', systemRouter)
      const res = await request(app).post('/api/system/stop')
      expect(res.status).toBe(202)
      expect(seen.length).toBe(1)
      expect(seen[0]?.type).toBe('system.stopping')
      expect(typeof seen[0]?.deadlineMs).toBe('number')
    } finally {
      off()
    }
  })

  it('returns 409 when a stop is already pending', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    __resetRestartRouter()
    const app = express()
    app.use(express.json())
    app.use((req: any, _res, next) => {
      req._instanceContext = { cwd: '/', cwdName: 'x', host: '127.0.0.1' }
      next()
    })
    app.use('/api', systemRouter)
    const first = await request(app).post('/api/system/stop')
    expect(first.status).toBe(202)
    const second = await request(app).post('/api/system/stop')
    expect(second.status).toBe(409)
    expect(second.body?.error).toBe('already_pending')
  })
})