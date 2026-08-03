import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import systemRouter, { __resetRestartRouter } from '../../../src/server/routes/system.js'
import { eventBus } from '../../../src/server/services/eventBus.js'
import { __resetBackgroundRuntimeForTests } from '../../../src/server/services/backgroundRuntime.js'

afterEach(() => {
  delete process.env.ZAI_SUPERVISOR_PID
  __resetRestartRouter()
  __resetBackgroundRuntimeForTests()
})

describe('POST /api/system/restart wiring', () => {
  beforeEach(() => {
    __resetRestartRouter()
    __resetBackgroundRuntimeForTests()
  })

  it('emits system.restarting on the event bus before draining', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    __resetRestartRouter()
    const seen: { type: string; reason?: string; deadlineMs?: number }[] = []
    const off = eventBus.subscribe((e) => {
      if (e.type === 'system.restarting') {
        seen.push({ type: e.type, reason: e.reason, deadlineMs: e.deadlineMs })
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
      const res = await request(app)
        .post('/api/system/restart')
        .send({ reason: 'user_action' })
      expect(res.status).toBe(202)
      expect(seen.length).toBe(1)
      expect(seen[0]?.type).toBe('system.restarting')
      expect(seen[0]?.reason).toBe('user_action')
      expect(typeof seen[0]?.deadlineMs).toBe('number')
    } finally {
      off()
    }
  })
})