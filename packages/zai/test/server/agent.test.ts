import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import agentRouter from '../../src/server/routes/agent.js'

// Mock agentRuntime — 不需要真实 LLM 跑, 我们只验证请求体透传
let lastRunOpts: any = null
// title patch 测试需要 mock store 可控:
// - mockTranscriptHasTitle 控制 read().meta.title 是否有值
// - patchCalls 记录所有 patch 调用, 断言 title 是否被写入
let mockTranscriptHasTitle = false
let patchCalls: Array<{ id: string; patch: { title?: string; tags?: string[] } }> = []
vi.mock('../../src/server/services/agentRuntime.js', () => ({
  getRuntime: () => ({
    run: (opts: any) => {
      lastRunOpts = opts
      // 输出 message_start / message_stop, 让 translateRuntimeEvents 生成
      // runtime.started / runtime.done, 触发 route 的 title patch 触发条件.
      return (async function* () {
        yield { type: 'message_start' }
        yield { type: 'message_stop' }
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
    read: async () => ({
      version: 1,
      transcriptId: 'sess-1',
      meta: {
        cwd: '/tmp',
        model: 'unknown',
        createdAt: 0,
        updatedAt: 0,
        ...(mockTranscriptHasTitle ? { title: 'existing-title' } : {}),
      },
      messages: [],
    }),
    patch: async (id: string, patch: { title?: string; tags?: string[] }) => {
      patchCalls.push({ id, patch })
    },
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

// Session title patch: 用户新建会话后, 第一次发消息应当用 prompt 的
// 第一行作为标题写入 transcript, 并 emit session.renamed 给前端. 重现
// "新建会话后 sidebar 标题不更新"的 bug.
describe('POST /api/agent/prompt title patch', () => {
  it('writes title derived from prompt first line and emits session.renamed', async () => {
    mockTranscriptHasTitle = false
    patchCalls = []
    // 订阅真实 eventBus, 捕获 server emit 的 SSE 事件
    const { eventBus } = await import('../../src/server/services/eventBus.js')
    const busEvents: any[] = []
    const off = eventBus.subscribe((e) => busEvents.push(e))
    try {
      const { url, close } = await startApp()
      try {
        const res = await fetch(`${url}/api/agent/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: '修复登录页的样式问题',
            sessionId: 'sess-new-1',
          }),
        })
        expect(res.status).toBe(200)
        // 排空响应流, 让 fire-and-forget 的 for-await 跑完
        const reader = res.body!.getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
        // 等一下 microtask 让最后的 patch 完成
        await new Promise((r) => setTimeout(r, 50))
        expect(patchCalls.length).toBe(1)
        expect(patchCalls[0].id).toBe('sess-new-1')
        expect(patchCalls[0].patch.title).toBe('修复登录页的样式问题')
        // 验证 session.renamed 已经发到 bus, 前端的 subscribeServerEvents
        // 会从这里接住再分发到 useAgentStore.applySessionEvent.
        const renamed = busEvents.find(
          (e) => e.type === 'session.renamed' && e.sessionId === 'sess-new-1',
        )
        expect(renamed).toBeDefined()
        expect(renamed.title).toBe('修复登录页的样式问题')
      } finally {
        close()
      }
    } finally {
      off()
    }
  })

  it('does not overwrite existing title on subsequent turns', async () => {
    mockTranscriptHasTitle = true
    patchCalls = []
    const { eventBus } = await import('../../src/server/services/eventBus.js')
    const busEvents: any[] = []
    const off = eventBus.subscribe((e) => busEvents.push(e))
    try {
      const { url, close } = await startApp()
      try {
        const res = await fetch(`${url}/api/agent/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: '追问细节',
            sessionId: 'sess-resume-1',
          }),
        })
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
        await new Promise((r) => setTimeout(r, 50))
        expect(patchCalls.length).toBe(0)
        // 续传场景不应发 session.renamed, 否则会覆盖用户已起的标题.
        const renamed = busEvents.filter((e) => e.type === 'session.renamed')
        expect(renamed.length).toBe(0)
      } finally {
        close()
      }
    } finally {
      off()
    }
  })
})