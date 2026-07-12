import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import agentRouter from '../../src/server/routes/agent.js'

// Mock agentRuntime — 不需要真实 LLM 跑, 我们只验证请求体透传
let lastRunOpts: any = null
vi.mock('../../src/server/services/agentRuntime.js', () => ({
  getRuntime: () => ({
    run: (opts: any) => {
      lastRunOpts = opts
      // 立刻结束的 async iterable, 避免 hanging
      return (async function* () {
        yield { type: 'runtime.done', eventId: 'd', sessionId: 'sess-1', ts: 0, turnIndex: 1 }
      })()
    },
    abort: async () => {},
    listSessions: async () => [],
    readSession: async () => ({ version: 1, transcriptId: 'sess-1', meta: {} as any, messages: [] }),
    patchSession: async () => {},
    removeSession: async () => {},
  }),
  getAskRegistry: () => ({ abortAll: () => {} }),
  getCurrentSessionId: () => 'sess-1',
  setCurrentSessionId: () => {},
  getTranscriptStore: () => ({
    list: async () => [],
    read: async () => ({ version: 1, transcriptId: 'sess-1', meta: {} as any, messages: [] }),
    patch: async () => {},
    remove: async () => {},
    append: async () => {},
  }),
  initAgentRuntime: () => {},
  abortAgentSession: async () => {},
}))

vi.mock('@zn-ai/zai-agent-core', () => ({
  loadAgentsMd: async () => null,
  buildAgentsMdSystemPrompt: () => null,
}))

function startApp(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const app = express()
    app.use(express.json())
    app.use('/api', agentRouter)
    const server = http.createServer(app).listen(0, () => {
      const addr = server.address() as any
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      })
    })
  })
}

describe('POST /api/agent/prompt with contentBlocks', () => {
  it('accepts contentBlocks without prompt (image-only)', async () => {
    lastRunOpts = null
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentBlocks: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          ],
        }),
      })
      // 400 是我们想要的: prompt 为空时 refine 应触发
      // v2 接受 image-only, 所以应该是 200 + activeSessionId
      expect([200, 202]).toContain(res.status)
      // 排空 stream
      const reader = res.body!.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(lastRunOpts).not.toBeNull()
      expect(Array.isArray(lastRunOpts.prompt)).toBe(true)
      expect(lastRunOpts.prompt[0].role).toBe('user')
      expect(Array.isArray(lastRunOpts.prompt[0].content)).toBe(true)
      expect(lastRunOpts.prompt[0].content[0].type).toBe('image')
    } finally {
      close()
    }
  })

  it('rejects when both prompt and contentBlocks are missing', async () => {
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp' }),
      })
      expect(res.status).toBe(400)
    } finally {
      close()
    }
  })
})