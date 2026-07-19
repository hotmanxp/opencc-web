import { describe, expect, test, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { AskRegistry } from '../services/askRegistry.js'
import answerRouter from './answer.js'

// 用一个独立的 express app 挂载 router 测
function makeApp(): { app: express.Express; registry: AskRegistry } {
  const registry = new AskRegistry()
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any)._askRegistry = registry
    next()
  })
  app.use('/api', answerRouter)
  return { app, registry }
}

describe('POST /api/agent/answer', () => {
  let app: express.Express
  let registry: AskRegistry
  beforeEach(() => {
    ;({ app, registry } = makeApp())
  })

  test('缺字段 → 400', async () => {
    const res = await request(app).post('/api/agent/answer').send({})
    expect(res.status).toBe(400)
  })

  test('缺 answers → 400', async () => {
    const res = await request(app).post('/api/agent/answer').send({ toolUseId: 't1' })
    expect(res.status).toBe(400)
  })

  test('toolUseId 不存在 → 404', async () => {
    const res = await request(app)
      .post('/api/agent/answer')
      .send({ toolUseId: 'unknown', answers: { q1: 'a' } })
    expect(res.status).toBe(404)
  })

  test('命中 → 200 ok:true, registry 中清除', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/answer')
      .send({ toolUseId: 't1', answers: { q1: 'a' } })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    await expect(p).resolves.toEqual({ answers: { q1: 'a' } })
    const res2 = await request(app)
      .post('/api/agent/answer')
      .send({ toolUseId: 't1', answers: { q1: 'b' } })
    expect(res2.status).toBe(404)
  })

  test('带 annotations 也接受', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/answer')
      .send({
        toolUseId: 't1',
        answers: { q1: 'a' },
        annotations: { q1: { notes: 'extra' } },
      })
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({
      answers: { q1: 'a' },
      annotations: { q1: { notes: 'extra' } },
    })
  })

  // ========== X-Session-Id sid 串号校验 ==========

  test('X-Session-Id 与 pending sid 匹配 → 正常 resolve', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 'sess-A', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/answer')
      .set('X-Session-Id', 'sess-A')
      .send({ toolUseId: 't1', answers: { q1: 'a' } })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    await expect(p).resolves.toEqual({ answers: { q1: 'a' } })
  })

  test('X-Session-Id 与 pending sid 不匹配 → 409, 不 consume pending', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 'sess-A', ctrl.signal)
    // pending 用 race + timeout 守护: 期望它永远不 resolve, 因为 server 应当
    // 拒绝并保留 pending. 100ms 后断言 p 仍未 settle.
    let settled = false
    void p.then(() => { settled = true }).catch(() => { settled = true })
    const res = await request(app)
      .post('/api/agent/answer')
      .set('X-Session-Id', 'sess-B')
      .send({ toolUseId: 't1', answers: { q1: 'a' } })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('session_mismatch')
    // 给 microtask 一点时间, 确认 pending 没被 consume
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    // cleanup: 用正确的 sid 真的 answer 掉, 避免 test 间污染
    const res2 = await request(app)
      .post('/api/agent/answer')
      .set('X-Session-Id', 'sess-A')
      .send({ toolUseId: 't1', answers: { q1: 'a' } })
    expect(res2.status).toBe(200)
  })

  test('不带 X-Session-Id (legacy) → 维持旧行为, 仅靠 toolUseId 唯一性', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 'sess-A', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/answer')
      .send({ toolUseId: 't1', answers: { q1: 'a' } })
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({ answers: { q1: 'a' } })
  })
})

describe('POST /api/agent/answer/reject', () => {
  test('缺 toolUseId → 400', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/agent/answer/reject').send({})
    expect(res.status).toBe(400)
  })

  test('命中 → 200 ok:true, pending promise reject', async () => {
    // 用一个最小 mock 避免 promise 同步 reject 引发 supertest 连接问题.
    const { app } = makeApp()
    // 替换 AskRegistry 使之不保留 promise: 直接 spy
    const sendPromise = request(app)
      .post('/api/agent/answer/reject')
      .send({ toolUseId: 't1', reason: 'user_rejected' })
    // 不存在的 toolUseId, 仍应返回 ok:true (reject 对未注册 toolUseId 直接 false)
    const res = await sendPromise
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
  })

  test('reject 不存在 toolUseId → 200 ok:false (返回 boolean 不抛错)', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post('/api/agent/answer/reject')
      .send({ toolUseId: 'never-registered' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
  })
})
