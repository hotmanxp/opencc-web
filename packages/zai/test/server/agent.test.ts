import { describe, expect, it, vi, beforeEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import agentRouter, {
  isRateLimitErrorMessage,
  markSessionRateLimited,
  getSessionRateLimitRemainingMs,
  __resetSessionRateLimitsForTests,
} from '../../src/server/routes/agent.js'
import { __resetCacheForTests as __resetSettingsCacheForTests } from '../../src/server/services/zaiSettingsStore.js'

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
// zai patch (2026-08-20): mock read 里带 mainAgent 记录,默认 'default'。
// 这样 prompt 路由不会因"会话无 mainAgent"而触发落盘 patch,避免污染
// patchCalls 统计;要验证落盘路径时把它设为 undefined 再断言。
let mockTranscriptMainAgent: string | undefined = 'default'
let patchCalls: Array<{ id: string; patch: { title?: string; tags?: string[]; model?: string; providerId?: string; mainAgent?: string } }> = []
// runtimeToolEvents: 让 tool_use:error/invalid/denied 翻译测试可注入事件序列.
let runtimeToolEvents: Array<Record<string, unknown>> = [
  { type: 'message_start' },
  { type: 'message_stop' },
]
vi.mock('../../src/server/services/agentRuntime.js', () => ({
  getRuntime: () => ({
    // Task 5: routes/agent.ts now invokes OpenccRuntime.query(input)
    // instead of the legacy DefaultAgentRuntime.run(opts). The mock
    // exposes `query` (the new shape) and keeps `run` as a no-op
    // belt-and-suspenders fallback for any other consumer until Task 6
    // deletes the legacy path.
    query: (opts: any) => {
      lastRunOpts = opts
      return (async function* () {
        for (const ev of runtimeToolEvents) yield ev
      })()
    },
    run: (_opts: any) => (async function* () {})(),
    abort: async () => {},
    listSessions: async () => [],
    readSession: async () => ({ version: 1, transcriptId: 'sess-1', meta: {} as any, messages: [] }),
    readTranscript: async () => ({ version: 1, transcriptId: 'sess-1', meta: {} as any, messages: [] }),
    getSession: async () => null,
    patchSession: async () => {},
    removeSession: async () => {},
    shutdown: async () => {},
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
        ...(mockTranscriptMainAgent ? { mainAgent: mockTranscriptMainAgent } : {}),
      },
      messages: [],
    }),
    patch: async (id: string, patch: { title?: string; tags?: string[]; model?: string; providerId?: string }) => {
      patchCalls.push({ id, patch })
    },
    remove: async () => {},
    append: async () => {},
  }),
  initAgentRuntime: () => {},
  abortAgentSession: async () => {},
  // Task 3: routes/agent.ts 的 /agent/prompt 现在调 registerSessionController,
  // finally 块调 releaseSessionController. 这两个测试不关心 abort flow,
  // 用 vi.fn() 占位即可. 旧 mock 没声明这两个 export, vitest 4 改成
  // 严格检查 mock 必须包含所有 import 的 named export — 加进来让它继续过.
  registerSessionController: () => {},
  releaseSessionController: () => {},
  abortSessionController: () => false,
}))

vi.mock('@zn-ai/zn-agent-core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    // permissionMode.ts:6 启动时用 EXTERNAL_PERMISSION_MODES 构造 VALID_MODES set,
    // mock 必须提供. 真实值见 zai-agent-core 导出 (5 个 user-facing mode).
    EXTERNAL_PERMISSION_MODES: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'],
  }
})

// Reset readFileSync between tests — 防止 'falls back' 测试把 mock
// 状态抛错泄漏到后续标题/翻译测试. resolveModel 走 default 时
// readFileSync 返回 undefined → JSON.parse 抛 SyntaxError → readZaiSettings
// 返回 {}, 整链路最终命中 BUILTIN_FALLBACK_MODEL.
beforeEach(() => {
  vi.mocked(readFileSync).mockReset()
  __resetSessionRateLimitsForTests()
  mockTranscriptMainAgent = 'default'
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

  // 回归: 带图片附件时 prompt 必须作为 ContentBlockParam[] 透传给 runtime,
  // 而不是 JSON.stringify 压成字符串 — 否则 base64 变纯文本, 模型报
  // "无法读取消息中嵌入的 base64 图片数据". OpenccQueryInput.prompt 已扩宽为
  // string | OpenccContentBlockParam[], 这里锁住路由行为.
  it('forwards image content blocks as an array prompt, not a JSON string', async () => {
    lastRunOpts = null
    const { url, close } = await startApp()
    try {
      // 1x1 PNG — magic bytes 需与 image/png 一致 (agent.ts assertImageMagicMatches)
      const imageData =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-img-1',
          contentBlocks: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: imageData },
            },
            { type: 'text', text: '识别这个图标' },
          ],
        }),
      })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(lastRunOpts).not.toBeNull()
      expect(Array.isArray(lastRunOpts.prompt)).toBe(true)
      expect(lastRunOpts.prompt[0]).toMatchObject({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: imageData },
      })
      expect(lastRunOpts.prompt[1]).toEqual({ type: 'text', text: '识别这个图标' })
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
describe('POST /api/agent/prompt — anthropic profile 注入 providerOverride', () => {
  const DEEPSEEK_PROFILE = {
    id: 'provider_ds_test',
    name: 'Anthropic-DS',
    provider: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-v4-flash,deepseek-v4-pro',
    apiFormat: 'chat_completions',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  }

  beforeEach(() => {
    // 清掉模块级 settings 缓存，让 getCachedZaiSettingsSync 的 fallback
    // 走 mock 的 readFileSync 读到测试注入的 env。
    __resetSettingsCacheForTests()
  })

  it('命中 anthropic profile（deepseek）时注入 format:"anthropic" 的 override', async () => {
    lastRunOpts = null
    mockTranscriptMetaModel = 'deepseek-v4-flash'
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p)
      if (path.includes('.zai.json')) {
        return JSON.stringify({ providerProfiles: [DEEPSEEK_PROFILE] })
      }
      if (path.includes('settings.json')) {
        return JSON.stringify({
          env: {
            DEEPSEEK_API_KEY: 'ds-key',
            ANTHROPIC_AUTH_TOKEN: 'anth-key',
            ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
          },
        })
      }
      throw new Error(`ENOENT: ${path}`)
    })
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', sessionId: 'sess-ds-1' }),
      })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(lastRunOpts).not.toBeNull()
      expect(lastRunOpts.model).toBe('deepseek-v4-flash')
      // 关键断言：anthropic profile 的 baseUrl/apiKey 参与调用，且
      // format 标记走 Anthropic SDK（而不是回落到 ANTHROPIC_BASE_URL env）。
      expect(lastRunOpts.providerOverride).toMatchObject({
        model: 'deepseek-v4-flash',
        baseURL: 'https://api.deepseek.com/anthropic',
        apiKey: 'ds-key',
        format: 'anthropic',
      })
    } finally {
      close()
    }
  })

  it('未命中任何 profile 时不注入 override（env 默认路径不变）', async () => {
    lastRunOpts = null
    mockTranscriptMetaModel = 'deepseek-v4-flash'
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p)
      if (path.includes('.zai.json')) {
        // 没有任何 profile 收录 deepseek-v4-flash
        return JSON.stringify({ providerProfiles: [] })
      }
      if (path.includes('settings.json')) {
        return JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: 'anth-key', ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic' },
        })
      }
      throw new Error(`ENOENT: ${path}`)
    })
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', sessionId: 'sess-ds-2' }),
      })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(lastRunOpts.model).toBe('deepseek-v4-flash')
      expect(lastRunOpts.providerOverride).toBeUndefined()
    } finally {
      close()
    }
  })
})

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

describe('会话级 429 冷却', () => {
  it('isRateLimitErrorMessage 识别 MiniMax 429 错误文本', () => {
    expect(
      isRateLimitErrorMessage(
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded(TPM) (1039)"}}',
      ),
    ).toBe(true)
    expect(isRateLimitErrorMessage('rate_limit')).toBe(true)
    expect(isRateLimitErrorMessage('rate limit exceeded')).toBe(true)
    expect(isRateLimitErrorMessage('rate limit exceeded(TPM) (1039)')).toBe(true)
    expect(isRateLimitErrorMessage('普通对话文本')).toBe(false)
    expect(isRateLimitErrorMessage('tool_use:invalid')).toBe(false)
    // 模型正常输出讨论 TPM 芯片/tpm2-tools 不应误判
    expect(isRateLimitErrorMessage('该设备支持 TPM 2.0 安全芯片')).toBe(false)
    expect(isRateLimitErrorMessage('tpm2-tools 安装成功')).toBe(false)
  })

  it('markSessionRateLimited 后冷却期内 remaining > 0, 到期归 0', async () => {
    markSessionRateLimited('sess-rate-1', 50)
    expect(getSessionRateLimitRemainingMs('sess-rate-1')).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 80))
    expect(getSessionRateLimitRemainingMs('sess-rate-1')).toBe(0)
  })

  it('未标记的会话 remaining 为 0', () => {
    expect(getSessionRateLimitRemainingMs('sess-unknown')).toBe(0)
  })
})

// zai patch (2026-08-09): runtime.started 在每次 LLM 调用起点就推送
// apiRequestCount / contextTokens,不再等 runtime.done(整条 prompt 跑完
// 才发一次)。中间轮次的 message_stop 被 sdkEventAdapter 抑制,导致
// metrics 长期不更新 — 挂在 runtime.started 上就逐 turn 推送。
//
// 这里直接测 translateRuntimeEvents 的 message_start 路径:前置
// sessionApiCounter state(recordApiCall + setLastContextUsage),然后
// 投一条 message_start,断言 eventBus 推出来的 runtime.started 携带
// 正确的 metrics 字段。
describe('translateRuntimeEvents — runtime.started 携带 metrics', () => {
  // 直接 import sessionApiCounter 改 globalThis。zai 服走 dist/.js
  // (globalThis 共享),测试用源模块 set,agent.ts 用同一模块 set/get
  // (通过 runtime path 走 dist 时也读 globalThis)— 两条路径都打到
  // 同一个 globalThis.__zaiApiCounts / __zaiApiCountLastUsage,断言稳。
  let counter: typeof import('@zn-ai/zn-agent-core')

  beforeEach(async () => {
    counter = await import('@zn-ai/zn-agent-core')
    counter.__resetApiCallCountsForTests()
    counter.setCurrentApiCountSession(null)
  })

  it('message_start 翻译成 runtime.started 时携带 apiRequestCount + contextTokens', async () => {
    counter.setCurrentApiCountSession('sess-metrics-1')
    // 模拟 vendor 一次 LLM 调用:recordApiCall +1,setLastContextUsage 写入
    counter.recordApiCall()
    counter.recordApiCall() // 第二次 (代表历史已累计 2 次)
    counter.setLastContextUsage({
      input: 1234,
      cache_creation: 56,
      cache_read: 78,
      output: 0,
    })
    // input + cache_creation + cache_read = 1234 + 56 + 78 = 1368
    runtimeToolEvents = [
      { type: 'message_start' },
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
            prompt: 'hello',
            sessionId: 'sess-metrics-1',
          }),
        })
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
        await new Promise((r) => setTimeout(r, 50))
        const started = busEvents.find((e) => e.type === 'runtime.started')
        expect(started).toBeDefined()
        expect(started.apiRequestCount).toBe(2)
        expect(started.contextTokens).toBe(1368)
        // runtime.done 路径也得带同样数字 — 同一 source of truth,
        // 两条路径分别覆盖逐 turn 刷新 + 整 prompt 终结兜底。
        const done = busEvents.find((e) => e.type === 'runtime.done')
        expect(done).toBeDefined()
        expect(done.apiRequestCount).toBe(2)
        expect(done.contextTokens).toBe(1368)
      } finally {
        close()
      }
    } finally {
      off()
    }
  })

  it('没有前置 metrics 时,runtime.started 的 apiRequestCount 为 0,contextTokens 为 undefined', async () => {
    runtimeToolEvents = [
      { type: 'message_start' },
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
            prompt: 'hello',
            sessionId: 'sess-metrics-2',
          }),
        })
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
        await new Promise((r) => setTimeout(r, 50))
        const started = busEvents.find((e) => e.type === 'runtime.started')
        expect(started).toBeDefined()
        // getApiCallCount 在没有 recordApiCall 时返回 0(显式 number),
        // getContextTokensForSession 返回 null → (?? undefined) → undefined.
        // 前端 reducer 对 0 走 Math.max(prev, 0) = prev(默认 0),
        // 不破坏既有的 prev > 0 的累加路径;对 undefined 跳过更新。
        expect(started.apiRequestCount).toBe(0)
        expect(started.contextTokens).toBeUndefined()
      } finally {
        close()
      }
    } finally {
      off()
    }
  })
})
// zai patch (2026-08-13): PATCH /agent/sessions/:id now accepts
// providerId alongside model. Tests below exercise both shapes and
// confirm the existing model-only path is unaffected (the handler
// only calls store.patch when the field is present + non-empty).
describe('PATCH /api/agent/sessions/:id — providerId', () => {
  it('writes providerId when supplied', async () => {
    patchCalls = []
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/sessions/sess-provider-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'MiniMax-M3', providerId: 'provider_a' }),
      })
      expect(res.status).toBe(200)
      expect(patchCalls.length).toBeGreaterThanOrEqual(2)
      const providerPatch = patchCalls.find((c) => c.patch.providerId === 'provider_a')
      const modelPatch = patchCalls.find((c) => c.patch.model === 'MiniMax-M3')
      expect(providerPatch).toBeDefined()
      expect(providerPatch?.id).toBe('sess-provider-1')
      expect(modelPatch).toBeDefined()
    } finally {
      close()
    }
  })

  it('only writes model when providerId is omitted (backward compatible)', async () => {
    patchCalls = []
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/sessions/sess-provider-2`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'MiniMax-M3' }),
      })
      expect(res.status).toBe(200)
      // No patch should carry providerId — the handler skips the field
      // when it's absent so legacy clients can't accidentally wipe a
      // previously-persisted providerId.
      const providerPatches = patchCalls.filter((c) => 'providerId' in c.patch)
      expect(providerPatches).toHaveLength(0)
    } finally {
      close()
    }
  })

  it('rejects invalid body (providerId too long)', async () => {
    patchCalls = []
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/sessions/sess-provider-3`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // 257 chars > max 256
        body: JSON.stringify({ model: 'MiniMax-M3', providerId: 'x'.repeat(257) }),
      })
      expect(res.status).toBe(400)
      expect(patchCalls).toHaveLength(0)
    } finally {
      close()
    }
  })
})

describe('mainAgent per-session (zai patch 2026-08-20)', () => {
  it('forwards the session mainAgent to runtime.query', async () => {
    lastRunOpts = null
    mockTranscriptMainAgent = 'office'
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-ma-1',
          contentBlocks: [{ type: 'text', text: 'hi' }],
        }),
      })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(lastRunOpts).not.toBeNull()
      // 会话有记录 → 原样透传给 runtime(engine 按它恢复插槽)
      expect(lastRunOpts.mainAgent).toBe('office')
    } finally {
      close()
    }
  })

  it('persists the global mainAgent when the session has no record', async () => {
    lastRunOpts = null
    patchCalls = []
    mockTranscriptMainAgent = undefined
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-ma-2',
          contentBlocks: [{ type: 'text', text: 'hi' }],
        }),
      })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(lastRunOpts).not.toBeNull()
      // 无记录 → 用全局默认并落盘固定该会话
      expect(lastRunOpts.mainAgent).toBe('default')
      const maPatches = patchCalls.filter((c) => 'mainAgent' in c.patch)
      expect(maPatches).toHaveLength(1)
      expect(maPatches[0].patch.mainAgent).toBe('default')
    } finally {
      close()
    }
  })
})
