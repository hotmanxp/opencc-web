import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'

// Hoisted mocks — must be declared before the route imports so the express
// router sees the mocked services.
const mocks = vi.hoisted(() => ({
  store: undefined as any,
  sessionId: '',
  repair: undefined as any,
}))

vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getTranscriptStore: () => mocks.store,
}))

vi.mock('@zn-ai/zai-agent-core/runtime', async () => {
  const actual = await vi.importActual<any>('@zn-ai/zai-agent-core/runtime')
  return {
    ...actual,
    repairAndPersistTranscript: (...args: unknown[]) => mocks.repair(...args),
  }
})

describe('POST /api/transcript/:sessionId/repair', () => {
  let app: express.Express
  let dataDir: string

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'zai-route-repair-'))
    const { TranscriptStore } = await import('@zn-ai/zai-agent-core/runtime')
    mocks.store = new TranscriptStore(dataDir)
    mocks.sessionId = await mocks.store.create({
      cwd: '/x',
      model: 'm',
      permissionMode: 'default',
    })
    mocks.repair = vi.fn(async () => ({
      messages: [],
      report: {
        repaired: true,
        repairedToolUseIds: ['orphan-1'],
        synthesizedToolUseIds: ['orphan-1'],
        droppedMessageUuids: [],
      },
    }))
    const { default: router } = await import('../../../src/server/routes/transcript.js')
    app = express()
    app.use(express.json())
    app.use('/api/transcript', router)
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('rejects invalid sessionId format', async () => {
    const res = await request(app)
      .post('/api/transcript/not-session/repair')
      .send()
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid sessionId/)
  })

  it('returns 404 when transcript does not exist', async () => {
    const res = await request(app)
      .post('/api/transcript/sess-does-not-exist/repair')
      .send()
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/transcript not found/)
  })

  it('invokes repairAndPersistTranscript and returns the report', async () => {
    const res = await request(app)
      .post(`/api/transcript/${mocks.sessionId}/repair`)
      .send()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      sessionId: mocks.sessionId,
      repaired: true,
      repairedToolUseIds: ['orphan-1'],
      synthesizedToolUseIds: ['orphan-1'],
    })
    expect(mocks.repair).toHaveBeenCalledOnce()
  })

  it('returns 500 when repair throws', async () => {
    mocks.repair = vi.fn(async () => { throw new Error('boom') })
    const res = await request(app)
      .post(`/api/transcript/${mocks.sessionId}/repair`)
      .send()
    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(/repair failed: boom/)
  })

  it('returns "no repair needed" when report.repaired is false', async () => {
    mocks.repair = vi.fn(async () => ({
      messages: [],
      report: {
        repaired: false,
        repairedToolUseIds: [],
        synthesizedToolUseIds: [],
        droppedMessageUuids: [],
      },
    }))
    const res = await request(app)
      .post(`/api/transcript/${mocks.sessionId}/repair`)
      .send()
    expect(res.status).toBe(200)
    expect(res.body.repaired).toBe(false)
  })
})
