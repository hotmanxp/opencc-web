import { describe, expect, test, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ApproveRegistry } from '../services/approveRegistry.js'
import approveRouter from './approve.js'

function makeApp(): { app: express.Express; registry: ApproveRegistry } {
  const registry = new ApproveRegistry()
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any)._approveRegistry = registry
    next()
  })
  app.use('/api', approveRouter)
  return { app, registry }
}

describe('POST /api/agent/approve', () => {
  let app: express.Express
  let registry: ApproveRegistry
  beforeEach(() => {
    ;({ app, registry } = makeApp())
  })

  test('缺字段 → 400', async () => {
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .send('{}')
    expect(res.status).toBe(400)
  })

  test('缺 decision → 400', async () => {
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ toolUseId: 't1' }))
    expect(res.status).toBe(400)
  })

  test('rejected 但缺 comment → 400', async () => {
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ toolUseId: 't1', decision: 'rejected' }))
    expect(res.status).toBe(400)
  })

  test('comment > 2000 chars → 400', async () => {
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({ toolUseId: 't1', decision: 'approved', comment: 'x'.repeat(2001) }),
      )
    expect(res.status).toBe(400)
  })

  test('toolUseId 不存在 → 404', async () => {
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ toolUseId: 'unknown', decision: 'approved' }))
    expect(res.status).toBe(404)
  })

  test('approved with comment → 200, promise resolves', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ toolUseId: 't1', decision: 'approved', comment: 'lgtm' }))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    await expect(p).resolves.toEqual({ decision: 'approved', comment: 'lgtm' })
  })

  test('approved without comment → 200', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ toolUseId: 't1', decision: 'approved' }))
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({ decision: 'approved' })
  })

  test('rejected with comment → 200, promise resolves', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ toolUseId: 't1', decision: 'rejected', comment: 'fix X' }))
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({ decision: 'rejected', comment: 'fix X' })
  })

  test('X-Session-Id 匹配 → 200', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 'sess-A', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .set('X-Session-Id', 'sess-A')
      .send(JSON.stringify({ toolUseId: 't1', decision: 'approved' }))
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({ decision: 'approved' })
  })

  test('X-Session-Id 不匹配 → 409, pending 不消费', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 'sess-A', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .set('X-Session-Id', 'sess-B')
      .send(JSON.stringify({ toolUseId: 't1', decision: 'approved' }))
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('session_mismatch')
    // Confirm pending NOT consumed by the bad-sid call. The route must
    // still be answerable; cleanup answers it. We do NOT use the
    // setTimeout-based race check (vitest flags unhandled rejection
    // warnings on the lingering p if the test exits before cleanup).
    expect(registry.peek('t1')).toBeDefined()
    registry.answer('t1', { decision: 'approved' })
    await p
  })

  test('不带 X-Session-Id → 维持旧行为', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 'sess-A', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .send({ toolUseId: 't1', decision: 'approved' })
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({ decision: 'approved' })
  })
})

describe('POST /api/agent/approve/reject', () => {
  test('缺 toolUseId → 400', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/agent/approve/reject').send({})
    expect(res.status).toBe(400)
  })

  test('命中 → 200 ok:true, promise reject', async () => {
    const { app, registry } = makeApp()
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve/reject')
      .send({ toolUseId: 't1', comment: 'no', reason: 'not_ready' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    await expect(p).rejects.toThrow('not_ready')
  })

  test('reject 不存在的 toolUseId → 200 ok:false', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post('/api/agent/approve/reject')
      .send({ toolUseId: 'nope', comment: 'no' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
  })
})
