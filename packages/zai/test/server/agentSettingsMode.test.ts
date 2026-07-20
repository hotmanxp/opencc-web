import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import path from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { TranscriptStore } from '@zn-ai/zai-agent-core'

// We need a fake cwd to feed the routes — agent.ts routes read req.app.locals.instanceContext.
let tmpDir: string
let dataDir: string

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'zai-mode-test-'))
  dataDir = path.join(tmpDir, 'data')
  mkdirSync(dataDir, { recursive: true })
  vi.doMock('../../src/server/services/agentRuntime.js', () => ({
    getRuntime: () => { throw new Error('not used in this test') },
    getTranscriptStore: () => new TranscriptStore(dataDir),
    getCurrentSessionId: () => null,
    setCurrentSessionId: () => {},
    abortAgentSession: async () => {},
  }))
  vi.doMock('../../src/server/services/permissionMode.js', () => ({
    getDefaultMode: () => 'acceptEdits',
  }))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  vi.doUnmock('../../src/server/services/agentRuntime.js')
  vi.doUnmock('../../src/server/services/permissionMode.js')
})

async function loadAgentRouter() {
  const mod = await import('../../src/server/routes/agent.js')
  return mod.default
}

function buildApp(router: express.Router) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req.app.locals as any).instanceContext = { cwd: tmpDir, cwdName: 'test' }
    next()
  })
  app.use('/api', router)
  return app
}

describe('PATCH /api/agent/sessions/:id permissionMode', () => {
  it('accepts a valid mode and persists it', async () => {
    const router = await loadAgentRouter()
    const app = buildApp(router)
    const store = new TranscriptStore(dataDir)
    const id = await store.create({ cwd: tmpDir, model: 'unknown' })

    const res = await request(app)
      .patch(`/api/agent/sessions/${id}`)
      .send({ permissionMode: 'plan' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const reloaded = await store.read(id)
    expect(reloaded.meta.permissionMode).toBe('plan')
  })

  it('rejects an invalid mode with 400', async () => {
    const router = await loadAgentRouter()
    const app = buildApp(router)
    const store = new TranscriptStore(dataDir)
    const id = await store.create({ cwd: tmpDir, model: 'unknown' })

    const res = await request(app)
      .patch(`/api/agent/sessions/${id}`)
      .send({ permissionMode: 'garbage' })

    expect(res.status).toBe(400)
    const reloaded = await store.read(id)
    expect(reloaded.meta.permissionMode).toBeUndefined()
  })

  it('returns 500 for unknown session id', async () => {
    const router = await loadAgentRouter()
    const app = buildApp(router)
    const res = await request(app)
      .patch('/api/agent/sessions/sess-does-not-exist')
      .send({ permissionMode: 'plan' })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

describe('GET /api/agent/sessions includes permissionMode', () => {
  it('returns the permissionMode field for each session', async () => {
    const router = await loadAgentRouter()
    const app = buildApp(router)
    const store = new TranscriptStore(dataDir)
    await store.create({ cwd: tmpDir, model: 'unknown', permissionMode: 'plan' })

    const res = await request(app).get('/api/agent/sessions')
    expect(res.status).toBe(200)
    expect(res.body.sessions.length).toBeGreaterThan(0)
    expect(res.body.sessions[0].permissionMode).toBe('plan')
  })
})

describe('POST /api/agent/sessions uses defaultMode', () => {
  it('initializes new sessions with the configured defaultMode', async () => {
    const router = await loadAgentRouter()
    const app = buildApp(router)
    const res = await request(app).post('/api/agent/sessions').send({})
    expect(res.status).toBe(200)
    expect(res.body.sessionId).toBeTruthy()
    const store = new TranscriptStore(dataDir)
    const transcript = await store.read(res.body.sessionId)
    expect(transcript.meta.permissionMode).toBe('acceptEdits')
  })
})