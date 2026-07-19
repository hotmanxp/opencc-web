import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { CwdStore } from '@zn-ai/zai-agent-core/runtime'
import agentRouter from './agent.js'

describe('GET /api/agent/sessions/:id/pwd', () => {
  let app: express.Express

  beforeEach(() => {
    CwdStore.clear()
    app = express()
    app.use('/api', agentRouter)
  })

  afterEach(() => {
    CwdStore.clear()
  })

  it('returns cwd for known sessionId', async () => {
    CwdStore.set('sess-known', '/tmp/somewhere')
    const res = await request(app).get('/api/agent/sessions/sess-known/pwd')
    expect(res.status).toBe(200)
    expect(res.body.cwd).toBe('/tmp/somewhere')
  })

  it('returns 404 for unknown sessionId', async () => {
    const res = await request(app).get('/api/agent/sessions/sess-unknown/pwd')
    expect(res.status).toBe(404)
    expect(res.body.error).toBeDefined()
  })
})