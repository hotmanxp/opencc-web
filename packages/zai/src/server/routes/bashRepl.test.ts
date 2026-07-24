import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import bashReplRouter from './bashRepl.js'
import { __resetReplRegistryForTest } from '../services/repl/ReplRegistry.js'

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.locals.instanceContext = { cwd: '/tmp', cwdName: 'tmp' }
  app.use('/api', bashReplRouter)
  return app
}

describe('bashRepl routes — exec / abort', () => {
  let app: express.Express

  beforeEach(() => {
    __resetReplRegistryForTest()
    app = makeApp()
  })

  afterEach(() => __resetReplRegistryForTest())

  it('POST exec 启动 child，返回 200 + execId', async () => {
    const res = await request(app)
      .post('/api/bash/repl/sess-1/exec')
      .send({ command: 'echo hello-repl' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.execId).toMatch(/^e-/)
    await new Promise((r) => setTimeout(r, 200))
  })

  it('POST exec 409 当 busy=true', async () => {
    await request(app).post('/api/bash/repl/sess-1/exec').send({ command: 'node -e "setTimeout(()=>{}, 30000)"' })
    const res = await request(app).post('/api/bash/repl/sess-1/exec').send({ command: 'echo second' })
    expect(res.status).toBe(409)
    expect(res.body.ok).toBe(false)
    expect(res.body.busy).toBe(true)
    expect(res.body.currentExecId).toMatch(/^e-/)
  })

  it('POST abort 触发 child 退出', async () => {
    await request(app).post('/api/bash/repl/sess-1/exec').send({ command: 'node -e "setTimeout(()=>{}, 30000)"' })
    const res = await request(app).post('/api/bash/repl/sess-1/abort').send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('POST abort 409 当无 child 在跑', async () => {
    const res = await request(app).post('/api/bash/repl/sess-1/abort').send({})
    expect(res.status).toBe(409)
  })

  // Brief originally asserted status 500 here, but Node's spawn('sh', ['-c', ...])
  // succeeds even when the inner command does not exist — `sh` returns exit 127
  // and the route completes with 200. Same resolution as Task 3 ReplSession tests.
  it('POST exec unknown command 仍返回 200，sh 退出 127 后 busy 释放', async () => {
    const res = await request(app)
      .post('/api/bash/repl/sess-1/exec')
      .send({ command: 'this-command-does-not-exist-xyz-12345' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.execId).toMatch(/^e-/)
    // 等 child 跑完 (`sh -c ...; exit 127`) → busy=false
    await new Promise((r) => setTimeout(r, 500))
    const abortRes = await request(app).post('/api/bash/repl/sess-1/abort').send({})
    expect(abortRes.status).toBe(409) // 无 child 在跑 → abort 409
  })
})