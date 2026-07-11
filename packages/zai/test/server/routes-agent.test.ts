import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import agentRouter from '../../src/server/routes/agent.js'

// Mock agentRuntime service
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
