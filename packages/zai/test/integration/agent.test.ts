import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import agentRouter from '../../src/server/routes/agent.js'

// Mock agentRuntime service
vi.mock('../../src/server/services/agentRuntime.js', () => ({
  initAgentRuntime: vi.fn(),
  getOrCreateAgentSession: vi.fn().mockResolvedValue('integration-session-id'),
  getRuntime: vi.fn().mockReturnValue({
    run: vi.fn().mockImplementation(async function* () {
      yield {
        eventId: 'i1',
        sessionId: 'integration-session-id',
        ts: Date.now(),
        turnIndex: 0,
        type: 'assistant.text',
        text: 'Integration response',
      }
      yield {
        eventId: 'i2',
        sessionId: 'integration-session-id',
        ts: Date.now(),
        turnIndex: 0,
        type: 'runtime.done',
      }
    }),
    abort: vi.fn().mockResolvedValue(undefined),
  }),
}))

// Mock zai-agent-core
vi.mock('@zn-ai/zai-agent-core', () => ({
  loadAgentsMd: vi.fn().mockResolvedValue({ files: [], raw: '' }),
  buildAgentsMdSystemPrompt: vi.fn().mockReturnValue(null),
}))

describe('Agent integration', () => {
  const app = express()
  app.use(express.json())
  app.use('/api', agentRouter)

  it('POST /api/agent/stream returns SSE headers', async () => {
    const res = await request(app)
      .post('/api/agent/stream')
      .send({ prompt: 'integration test' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.headers['cache-control']).toContain('no-cache')
    expect(res.text).toContain('Integration response')
    expect(res.text).toContain('runtime.done')
  })

  it('POST /api/agent/abort returns ok', async () => {
    const res = await request(app).post('/api/agent/abort')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('ok', true)
    expect(res.body).toHaveProperty('sessionId', 'integration-session-id')
  })

  it('POST /api/agent/stream emits runtime.error envelope for oversized prompt', async () => {
    const res = await request(app)
      .post('/api/agent/stream')
      .send({ prompt: 'x'.repeat(32_001) })
    expect(res.status).toBe(400)
  })
})
