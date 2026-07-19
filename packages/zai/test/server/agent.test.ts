import { describe, expect, it, vi, beforeEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import agentRouter from '../../src/server/routes/agent.js'

// Mock node:fs so resolveModel's readZaiSettings() can be controlled.
// Mirrors the pattern in test/server/agentSettings.test.ts:7-13.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: vi.fn(),
  }
})

// Mock agentRuntime — 不需要真实 LLM 跑, 我们只验证请求体透传
let lastRunOpts: any = null
// title patch 测试需要 mock store 可控:
// - mockTranscriptHasTitle 控制 read().meta.title 是否有值
// - patchCalls 记录所有 patch 调用, 断言 title 是否被写入
let mockTranscriptHasTitle = false
let mockTranscriptMetaModel: string = 'unknown'
let patchCalls: Array<{ id: string; patch: { title?: string; tags?: string[]; model?: string } }> = []
// runtimeToolEvents: 让 tool_use:error/invalid/denied 翻译测试可注入事件序列.
let runtimeToolEvents: Array<Record<string, unknown>> = [
  { type: 'message_start' },
  { type: 'message_stop' },
]
vi.mock('../../src/server/services/agentRuntime.js', () => ({
  getRuntime: () => ({
    run: (opts: any) => {
      lastRunOpts = opts
      return (async function* () {
        for (const ev of runtimeToolEvents) yield ev
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
        // mockTranscriptMetaModel controls the meta.model value the
        // route reads when resolving per-session model. Default 'unknown'
        // (matches existing tests).
        model: mockTranscriptMetaModel,
        createdAt: 0,
        updatedAt: 0,
        ...(mockTranscriptHasTitle ? { title: 'existing-title' } : {}),
      },
      messages: [],
    }),
    patch: async (id: string, patch: { title?: string; tags?: string[]; model?: string }) => {
      patchCalls.push({ id, patch })
    },
    remove: async () => {},
    append: async () => {},
  }),
  initAgentRuntime: () => {},
  abortAgentSession: async () => {},
}))

vi.mock('@zn-ai/zai-agent-core', () => ({
  // permissionMode.ts:6 启动时用 EXTERNAL_PERMISSION_MODES 构造 VALID_MODES set,
  // mock 必须提供. 真实值见 zai-agent-core 导出 (5 个 user-facing mode).
  EXTERNAL_PERMISSION_MODES: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'],
}))

// Reset readFileSync between tests — 防止 'falls back' 测试把 mock
// 状态抛错泄漏到后续标题/翻译测试. resolveModel 走 default 时
// readFileSync 返回 undefined → JSON.parse 抛 SyntaxError → readZaiSettings
// 返回 {}, 整链路最终命中 BUILTIN_FALLBACK_MODEL.
beforeEach(() => {
  vi.mocked(readFileSync).mockReset()
})

function startApp(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const app = express()
    app.use(express.json())
    // agent.ts:293 期待 req.app.locals.instanceContext. server/index.ts 启动时设,
    // 测试用 startApp 走真实 http, 必须手动设. cwd 选 /tmp 避免污染 home 目录.
    app.locals.instanceContext = { cwd: '/tmp', cwdName: 'agent-test' }
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

// 关键: /agent/prompt 必须从 transcript.meta.model 读到 session 选过的
// 模型, 通过 resolveModel 透传给 runtime.run({ model }). 三种情形:
// 1) sessionModel = 'unknown' → 走 fallback (settings/env -> BUILTIN_FALLBACK_MODEL)
// 2) sessionModel = '<resolvedName>' → 直接用它
// 3) meta.model 缺失 (read 抛错) → 走 fallback
describe('POST /api/agent/prompt model resolution', () => {
  it('forwards transcript.meta.model to runtime.run when set', async () => {
    lastRunOpts = null
    mockTranscriptMetaModel = 'MiniMax-M2.7-highspeed'
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', sessionId: 'sess-model-1' }),
      })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(lastRunOpts).not.toBeNull()
      expect(lastRunOpts.model).toBe('MiniMax-M2.7-highspeed')
    } finally {
      close()
    }
  })

  it('falls back to BUILTIN_FALLBACK_MODEL when transcript.meta.model is "unknown"', async () => {
    lastRunOpts = null
    mockTranscriptMetaModel = 'unknown'
    // 清空 readFileSync 让 resolveModel 走 builtin fallback.
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT')
    })
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', sessionId: 'sess-model-2' }),
      })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(lastRunOpts.model).toBe('MiniMax-M3')
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

// 回归: server 把 tool_use:error/invalid/denied 翻译成 runtime.error 时
// 丢失 toolUseId → 前端无法 upsert 对应工具, ToolCallBlock 卡在"调用中".
// 修复后 runtime.error 必须携带 toolUseId.
describe('translateRuntimeEvents — tool_use:error 携带 toolUseId', () => {
  it('tool_use:error 翻译成 runtime.error 时携带 toolUseId', async () => {
    runtimeToolEvents = [
      { type: 'message_start' },
      // Anthropic 风格的 tool_use 块 (content_block_start → stop 完成)
      {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tu_err_1', name: 'Bash' },
      },
      {
        type: 'content_block_stop',
      },
      // runtime 工具执行抛错
      {
        type: 'tool_use:error',
        toolUseId: 'tu_err_1',
        error: 'spawn ENOENT',
      },
      { type: 'message_stop' },
    ]
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
            prompt: 'run shell',
            sessionId: 'sess-err-translate-1',
          }),
        })
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
        await new Promise((r) => setTimeout(r, 50))
        const errEvent = busEvents.find(
          (e) => e.type === 'runtime.error' && e.toolUseId === 'tu_err_1',
        )
        expect(errEvent).toBeDefined()
        expect(errEvent.error.category).toBe('tool')
        expect(errEvent.error.message).toBe('spawn ENOENT')
      } finally {
        close()
      }
    } finally {
      off()
    }
  })

  it('tool_use:invalid / denied 同样携带 toolUseId', async () => {
    runtimeToolEvents = [
      { type: 'message_start' },
      // invalid 路径
      { type: 'tool_use:invalid', toolUseId: 'tu_inv_1', error: 'invalid input: bad cmd' },
      { type: 'message_stop' },
    ]
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
            prompt: 'inv',
            sessionId: 'sess-err-translate-2',
          }),
        })
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
        await new Promise((r) => setTimeout(r, 50))
        const invalid = busEvents.find(
          (e) => e.type === 'runtime.error' && e.toolUseId === 'tu_inv_1',
        )
        expect(invalid).toBeDefined()
        expect(invalid.error.message).toContain('invalid input')
      } finally {
        close()
      }
    } finally {
      off()
    }
  })
})