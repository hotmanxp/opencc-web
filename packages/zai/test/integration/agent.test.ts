import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import agentRouter from '../../src/server/routes/agent.js'

// Mock agentRuntime service
vi.mock('../../src/server/services/agentRuntime.js', () => ({
  initAgentRuntime: vi.fn(),
  getOrCreateAgentSession: vi.fn().mockResolvedValue('integration-session-id'),
  getCurrentSessionId: vi.fn().mockReturnValue('integration-session-id'),
  setCurrentSessionId: vi.fn(),
  abortAgentSession: vi.fn().mockResolvedValue(undefined),
  getAskRegistry: vi.fn().mockReturnValue({ abortAll: vi.fn() }),
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

// Mock zai-agent-core. 用 importOriginal 透传实际类, 再补齐 agent.ts / permissionMode.ts
// 实际会用到的 exports (EXTERNAL_PERMISSION_MODES / loadAgentsMd / buildAgentsMdSystemPrompt).
vi.mock('@zn-ai/zai-agent-core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadAgentsMd: vi.fn().mockResolvedValue({ files: [], raw: '' }),
    buildAgentsMdSystemPrompt: vi.fn().mockReturnValue(null),
    EXTERNAL_PERMISSION_MODES: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'],
  }
})

describe('Agent integration', () => {
  const app = express()
  app.use(express.json())
  // agent.ts:293 期望 req.app.locals.instanceContext = { cwd, cwdName }.
  // server/index.ts 启动时会设, 这里测试用要手动设.
  app.locals.instanceContext = { cwd: '/tmp', cwdName: 'integration-test' }
  app.use('/api', agentRouter)

  it('POST /api/agent/prompt returns 200 and JSON sessionId envelope', async () => {
    // /api/agent/prompt 是 fire-and-forget 设计: 立即 res.json({ sessionId }),
    // 真正的 SSE 流在后台异步推送 (agent.ts:287 + 注释 line 321-336). supertest 等不到
    // SSE 流结束, 但能拿到立即返回的 JSON envelope.
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({ prompt: 'integration test' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('sessionId')
  })

  it('POST /api/agent/abort returns ok', async () => {
    const res = await request(app).post('/api/agent/abort')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('ok', true)
    expect(res.body).toHaveProperty('sessionId', 'integration-session-id')
  })

  it('POST /api/agent/prompt emits runtime.error envelope for oversized prompt', async () => {
    const res = await request(app)
      .post('/api/agent/prompt')
      .send({ prompt: 'x'.repeat(32_001) })
    expect(res.status).toBe(400)
  })
})
