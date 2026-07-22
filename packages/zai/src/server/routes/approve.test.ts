import { describe, expect, test, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { ApproveRegistry } from '../services/approveRegistry.js'
import approveRouter from './approve.js'

function makeApp(): { app: express.Express; registry: ApproveRegistry; cwd: string } {
  const registry = new ApproveRegistry()
  // Each app gets its own cwd so file-fetch tests don't share state.
  // Tests that don't read files ignore this.
  const cwd = process.cwd()
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any)._approveRegistry = registry
    next()
  })
  app.use((req, _res, next) => {
    ;(req as any).app.locals ?? null
    next()
  })
  app.locals.instanceContext = { cwd, cwdName: 'test' }
  app.use('/api', approveRouter)
  return { app, registry, cwd }
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
    const p = registry.register('t1', 's1', '/tmp/spec.md', ctrl.signal)
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
    const p = registry.register('t1', 's1', '/tmp/spec.md', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ toolUseId: 't1', decision: 'approved' }))
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({ decision: 'approved' })
  })

  test('rejected with comment → 200, promise resolves', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', '/tmp/spec.md', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ toolUseId: 't1', decision: 'rejected', comment: 'fix X' }))
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({ decision: 'rejected', comment: 'fix X' })
  })

  test('X-Session-Id 匹配 → 200', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 'sess-A', '/tmp/spec.md', ctrl.signal)
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
    const p = registry.register('t1', 'sess-A', '/tmp/spec.md', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .set('X-Session-Id', 'sess-B')
      .send(JSON.stringify({ toolUseId: 't1', decision: 'approved' }))
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('session_mismatch')
    expect(registry.peek('t1')).toBeDefined()
    registry.answer('t1', { decision: 'approved' })
    await p
  })

  test('不带 X-Session-Id → 维持旧行为', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 'sess-A', '/tmp/spec.md', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ toolUseId: 't1', decision: 'approved' }))
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({ decision: 'approved' })
  })
})

describe('POST /api/agent/approve/reject', () => {
  test('缺 toolUseId → 400', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post('/api/agent/approve/reject')
      .set('Content-Type', 'application/json')
      .send('{}')
    expect(res.status).toBe(400)
  })

  test('命中 → 200 ok:true, promise reject', async () => {
    const { app, registry } = makeApp()
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', '/tmp/spec.md', ctrl.signal)
    void p.catch(() => {})
    const res = await request(app)
      .post('/api/agent/approve/reject')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ toolUseId: 't1', comment: 'no', reason: 'not_ready' }))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    await expect(p).rejects.toThrow('not_ready')
  })

  test('reject 不存在的 toolUseId → 200 ok:false', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post('/api/agent/approve/reject')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ toolUseId: 'nope', comment: 'no' }))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
  })
})

describe('GET /api/agent/approve/file', () => {
  let tmpDir: string
  let app: express.Express
  let registry: ApproveRegistry

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'approve-file-'))
    const made = makeApp()
    app = made.app
    registry = made.registry
    // Override cwd with the temp dir so the file-path resolver lands on it.
    app.locals.instanceContext = { cwd: tmpDir, cwdName: 'test' }
  })

  test('缺少 toolUseId → 400', async () => {
    const res = await request(app).get('/api/agent/approve/file')
    expect(res.status).toBe(400)
  })

  test('toolUseId 没注册 → 404', async () => {
    const res = await request(app)
      .get('/api/agent/approve/file')
      .query({ toolUseId: 'unknown' })
    expect(res.status).toBe(404)
  })

  test('sid mismatch → 403', async () => {
    const ctrl = new AbortController()
    registry.register('t1', 'sess-A', '/tmp/spec.md', ctrl.signal)
    const res = await request(app)
      .get('/api/agent/approve/file')
      .query({ toolUseId: 't1' })
      .set('X-Session-Id', 'sess-B')
    expect(res.status).toBe(403)
  })

  test('happy path: 读到 content + bytes (绝对路径)', async () => {
    const docsDir = path.join(tmpDir, 'docs')
    await fs.mkdir(docsDir, { recursive: true })
    const filePath = path.join(tmpDir, 'docs', 'spec.md')
    const content = '# Spec\n\nHello world'
    await fs.writeFile(filePath, content, 'utf-8')
    const ctrl = new AbortController()
    registry.register('t1', 's1', filePath, ctrl.signal)
    const res = await request(app)
      .get('/api/agent/approve/file')
      .query({ toolUseId: 't1' })
    expect(res.status).toBe(200)
    expect(res.body.toolUseId).toBe('t1')
    expect(res.body.filePath).toBe(filePath)
    expect(res.body.content).toBe(content)
    expect(res.body.bytes).toBe(content.length)
  })

  test('file missing → 404 file_unreadable', async () => {
    const ctrl = new AbortController()
    registry.register('t1', 's1', path.join(tmpDir, 'docs', 'missing.md'), ctrl.signal)
    const res = await request(app)
      .get('/api/agent/approve/file')
      .query({ toolUseId: 't1' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('file_unreadable')
  })

  test('空文件 → 200, content:""', async () => {
    const docsDir = path.join(tmpDir, 'docs')
    await fs.mkdir(docsDir, { recursive: true })
    const filePath = path.join(tmpDir, 'docs', 'empty.md')
    await fs.writeFile(filePath, '', 'utf-8')
    const ctrl = new AbortController()
    registry.register('t1', 's1', filePath, ctrl.signal)
    const res = await request(app)
      .get('/api/agent/approve/file')
      .query({ toolUseId: 't1' })
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('')
    expect(res.body.bytes).toBe(0)
  })

  test('absolute path outside session cwd is still resolvable', async () => {
    // The route no longer anchors paths to the session cwd — that's the
    // agent's responsibility. Verify a path outside the temp cwd resolves
    // and reads correctly. We write the file directly under os.tmpdir().
    const filePath = path.join(os.tmpdir(), `approve-outside-${process.pid}-${Date.now()}.md`)
    const content = '# outside\n\nok'
    try {
      await fs.writeFile(filePath, content, 'utf-8')
      const ctrl = new AbortController()
      registry.register('t1', 's1', filePath, ctrl.signal)
      const res = await request(app)
        .get('/api/agent/approve/file')
        .query({ toolUseId: 't1' })
      expect(res.status).toBe(200)
      expect(res.body.filePath).toBe(filePath)
      expect(res.body.content).toBe(content)
    } finally {
      await fs.unlink(filePath).catch(() => {})
    }
  })
})
