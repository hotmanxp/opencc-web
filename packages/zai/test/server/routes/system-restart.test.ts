import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import request from 'supertest'
import systemRouter, { __resetRestartRouter } from '../../../src/server/routes/system.js'

afterEach(() => { delete process.env.ZAI_SUPERVISOR_PID })

describe('POST /api/system/restart', () => {
  beforeEach(() => {
    __resetRestartRouter()
  })

  it('returns 409 when not managed', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', systemRouter)
    const res = await request(app).post('/api/system/restart').send({ reason: 'user_action' })
    expect(res.status).toBe(409)
  })

  it('returns 202 when managed and triggers restart', async () => {
    process.env.ZAI_SUPERVISOR_PID = '9999'
    __resetRestartRouter()
    let captured: any = null
    ;(process as any).send = (m: any) => { captured = m; return true }
    const app = express()
    app.use(express.json())
    app.use((req: any, _res, next) => { req._instanceContext = { cwd: '/', cwdName: 'x', host: '127.0.0.1' }; next() })
    app.use('/api', systemRouter)
    const res = await request(app).post('/api/system/restart').send({ reason: 'user_action' })
    expect(res.status).toBe(202)
    expect(captured?.type).toBe('restarted')
  })
})
