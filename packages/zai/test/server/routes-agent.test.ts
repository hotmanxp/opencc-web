import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import agentRouter from '../../src/server/routes/agent.js'

// Mock agentRuntime service — transcript store is needed for PATCH /sessions/:id
let patchCalls: Array<{ id: string; patch: { model?: string; title?: string } }> = []
vi.mock('../../src/server/services/agentRuntime.js', () => ({
  initAgentRuntime: vi.fn(),
  getOrCreateAgentSession: vi.fn().mockResolvedValue('test-session-id'),
  getRuntime: vi.fn().mockReturnValue({
    run: vi.fn().mockImplementation(async function* () {
      yield {
        eventId: 'e1',
        sessionId: 'test-session-id',
        ts: Date.now(),
        turnIndex: 0,
        type: 'assistant.text',
        text: 'Hello!',
      }
      yield {
        eventId: 'e2',
        sessionId: 'test-session-id',
        ts: Date.now(),
        turnIndex: 0,
        type: 'runtime.done',
      }
    }),
    abort: vi.fn().mockResolvedValue(undefined),
  }),
  getCurrentSessionId: () => 'test-session-id',
  setCurrentSessionId: () => {},
  getTranscriptStore: () => ({
    list: async () => [],
    read: async () => ({
      version: 1,
      transcriptId: 'test-session-id',
      meta: { cwd: '/tmp', model: 'unknown', createdAt: 0, updatedAt: 0 },
      messages: [],
    }),
    patch: async (id: string, patch: { model?: string; title?: string }) => {
      patchCalls.push({ id, patch })
    },
    remove: async () => {},
    append: async () => {},
  }),
}))

// Mock @zn-ai/zai-agent-core
vi.mock('@zn-ai/zai-agent-core', () => ({
  loadAgentsMd: vi.fn().mockResolvedValue({ files: [] }),
  buildAgentsMdSystemPrompt: vi.fn().mockReturnValue(null),
}))

const app = express()
app.use(express.json())
app.use('/api', agentRouter)

describe('POST /api/agent/stream', () => {
  it('returns SSE stream with RuntimeEvent', async () => {
    const res = await request(app)
      .post('/api/agent/stream')
      .send({ prompt: 'hi' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.text).toContain('assistant.text')
    expect(res.text).toContain('Hello!')
    expect(res.text).toContain('runtime.done')
  })

  it('rejects empty prompt', async () => {
    const res = await request(app)
      .post('/api/agent/stream')
      .send({ prompt: '' })
    expect(res.status).toBe(400)
  })

  it('rejects missing prompt', async () => {
    const res = await request(app)
      .post('/api/agent/stream')
      .send({})
    expect(res.status).toBe(400)
  })
})

describe('POST /api/agent/abort', () => {
  it('aborts current session', async () => {
    const res = await request(app)
      .post('/api/agent/abort')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, sessionId: 'test-session-id' })
  })
})

describe('PATCH /api/agent/sessions/:id', () => {
  beforeEach(() => {
    patchCalls = []
  })

  it('writes model to transcript meta', async () => {
    const res = await request(app)
      .patch('/api/agent/sessions/sess-1')
      .send({ model: 'MiniMax-M3' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(patchCalls).toEqual([{ id: 'sess-1', patch: { model: 'MiniMax-M3' } }])
  })

  it('rejects invalid body (missing or non-string model)', async () => {
    const res = await request(app)
      .patch('/api/agent/sessions/sess-1')
      .send({ model: 123 })
    expect(res.status).toBe(400)
  })

  it('does not write when model is "unknown" placeholder', async () => {
    const res = await request(app)
      .patch('/api/agent/sessions/sess-1')
      .send({ model: 'unknown' })
    expect(res.status).toBe(200)
    expect(patchCalls.length).toBe(0)
  })

  it('accepts empty body (no-op patch)', async () => {
    const res = await request(app)
      .patch('/api/agent/sessions/sess-1')
      .send({})
    expect(res.status).toBe(200)
    expect(patchCalls.length).toBe(0)
  })
})
