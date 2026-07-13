import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'
import type { ModelEntry } from '../../src/shared/settings.js'

// 模拟一条典型 turn 内的 SSE 事件序列:
//   text-block-0 (delta x N) → tool-X start/done → text-block-2 (delta x N)
// 验证: 两段 text 落到 messages 数组里两个不同的 assistant.text 条目,
// 工具落成一个 tool_use:start/done 条目, 整体顺序保留 (text0 → toolX → text2).
describe('useAgentStore — text / tool / text 交错事件', () => {
  beforeEach(() => {
    useAgentStore.setState({
      messages: [],
      textSegmentRev: 0,
      segmentedToolUseIds: {},
      sendSeq: 0,
    })
  })

  it('text→tool→text 流式事件产生 2 个独立 text 气泡 + 1 个 tool 气泡, 顺序保持', () => {
    const state = useAgentStore.getState()
    const sessionId = 'sess-1'

    // 1) text-block-0 首条 delta — segment=0, blockIndex=0
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      '让我看一下 '
    )
    // 2) text-block-0 后续 delta — 同 segment/block, 应当 append 而非新建
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      '当前文件内容.'
    )

    // 3) Anthropic 提前宣告的 content_block_start(tool_use) — blockIndex=1
    // 这一步是关键: store 内部应当把 textSegmentRev 从 0 推到 1.
    state.upsertToolCall({
      eventId: 'cbs-1',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { cmd: 'ls' } },
    })

    // 4) tool_use:start — 同一 toolUseId, 不再重复 bump
    state.upsertToolCall({
      eventId: 'start-1',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 'toolu_x',
      name: 'Bash',
      input: { cmd: 'ls' },
    })

    // 5) tool_use:done
    state.upsertToolCall({
      eventId: 'done-1',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:done',
      toolUseId: 'toolu_x',
      output: 'file1.txt\nfile2.txt',
    })

    // 6) text-block-2 首条 delta — segment 现已被工具 bump 到 1, 与 text-block-0 错位
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 2 } as any,
      '好的, 一共 2 个文件.'
    )

    expect(useAgentStore.getState().textSegmentRev).toBe(1)

    const messages = useAgentStore.getState().messages
    const texts = messages.filter((m) => m.type === 'assistant.text')
    const tools = messages.filter(
      (m) =>
        m.type === 'tool_use:start' ||
        m.type === 'tool_use:done' ||
        m.type === 'content_block_start',
    )

    expect(texts).toHaveLength(2)
    expect(tools).toHaveLength(1) // start/done 由 toolUseId upsert 合并到一条
    expect(tools[0]!.type).toBe('tool_use:done')
    expect(tools[0]!.name).toBe('Bash')
    expect(tools[0]!.toolUseId).toBe('toolu_x')

    // 顺序: text0 (segment 0) → toolX → text2 (segment 1)
    expect(texts[0]!.text).toBe('让我看一下 当前文件内容.')
    expect(texts[1]!.text).toBe('好的, 一共 2 个文件.')

    // 两段 text 的 eventId 不同 — 这是气泡分开的关键
    expect(texts[0]!.eventId).not.toBe(texts[1]!.eventId)

    // messages 数组顺序断言: text0 → toolX → text2
    expect(messages.map((m) => m.type)).toEqual([
      'assistant.text',
      'tool_use:done',
      'assistant.text',
    ])
  })

  it('同一 stream block 的 delta 合并进同一气泡', () => {
    const state = useAgentStore.getState()
    const sessionId = 'sess-2'

    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      '你好'
    )
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      ', 世界'
    )

    const texts = useAgentStore.getState().messages.filter((m) => m.type === 'assistant.text')
    expect(texts).toHaveLength(1)
    expect(texts[0]!.text).toBe('你好, 世界')
  })

  it('工具起点后的 text 落在新气泡 (即使 blockIndex 巧合相同)', () => {
    // 复现真实场景: Anthropic SDK 没有正确递增 blockIndex (例如两次都是
    // content_block_delta.index=0), 只要 store 捕捉到 tool_use:start,
    // 下一段文字就应该走新 segment.
    const state = useAgentStore.getState()
    const sessionId = 'sess-3'

    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      '段 A'
    )
    // 工具调用 — store 应 bump textSegmentRev
    state.upsertToolCall({
      eventId: 's',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 't1',
      name: 'Bash',
      input: {},
    })
    // Anthropic 在某些实现下可能再次用 index=0 派发下一段 delta;
    // store 仍然应当视作新气泡.
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      '段 B'
    )

    const texts = useAgentStore.getState().messages.filter((m) => m.type === 'assistant.text')
    expect(texts).toHaveLength(2)
    expect(texts[0]!.text).toBe('段 A')
    expect(texts[1]!.text).toBe('段 B')
  })

  it('同一 toolUseId 多次 tool_use:start 不重复 bump', () => {
    const state = useAgentStore.getState()
    const sessionId = 'sess-4'

    // content_block_start(tool_use) 先声明
    state.upsertToolCall({
      eventId: 'cbs',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    })
    expect(useAgentStore.getState().textSegmentRev).toBe(1)

    // 再来 tool_use:start 同 id — 不应再 bump
    state.upsertToolCall({
      eventId: 'start',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 't1',
      name: 'Bash',
      input: {},
    })
    expect(useAgentStore.getState().textSegmentRev).toBe(1)

    // tool_use:done 同 id — 不应再 bump
    state.upsertToolCall({
      eventId: 'done',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:done',
      toolUseId: 't1',
      output: 'ok',
    })
    expect(useAgentStore.getState().textSegmentRev).toBe(1)
  })

  it('多个工具依次调用时, 每次都 bump, text 段计 2 次错位', () => {
    const state = useAgentStore.getState()
    const sessionId = 'sess-5'

    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      'before'
    )
    state.upsertToolCall({
      eventId: 's1',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 't1',
      name: 'Bash',
      input: {},
    })
    state.upsertToolCall({
      eventId: 'd1',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:done',
      toolUseId: 't1',
      output: '',
    })
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      'middle'
    )
    state.upsertToolCall({
      eventId: 's2',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 't2',
      name: 'Bash',
      input: {},
    })
    state.upsertToolCall({
      eventId: 'd2',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:done',
      toolUseId: 't2',
      output: '',
    })
    state.upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      'after'
    )

    const texts = useAgentStore.getState().messages.filter((m) => m.type === 'assistant.text')
    expect(texts).toHaveLength(3)
    expect(texts.map((t) => t.text)).toEqual(['before', 'middle', 'after'])
    expect(useAgentStore.getState().textSegmentRev).toBe(2)
  })

  it('clearMessages 重置 textSegmentRev / segmentedToolUseIds', () => {
    const state = useAgentStore.getState()
    const sessionId = 'sess-6'

    state.upsertToolCall({
      eventId: 's',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 't1',
      name: 'Bash',
      input: {},
    })
    expect(useAgentStore.getState().textSegmentRev).toBe(1)
    expect(useAgentStore.getState().segmentedToolUseIds['t1']).toBe(true)

    useAgentStore.getState().clearMessages()
    expect(useAgentStore.getState().textSegmentRev).toBe(0)
    expect(useAgentStore.getState().segmentedToolUseIds).toEqual({})
  })

  // 回归: 跨轮次消息归并 bug.
  // 上一轮回答是纯文本 (无工具调用) → textSegmentRev 停在 0; 新一轮首个
  // 文本 delta 的 blockIndex 也从 0 起, 后端 turnIndex 恒为 0. 若 key 里
  // 不含 sendSeq, 相邻两轮首个文本块会拼出同一个 `0:0:0:text`, 新一轮文本
  // 被 append 进上一轮气泡 (显示在用户消息上方, 归到上一条 LLM 消息).
  // sendMessage 每轮递增 sendSeq, 保证两轮 key 隔离.
  it('两轮纯文本回答 (无工具) 不会归并到同一气泡', () => {
    const sessionId = 'sess-7'

    // --- 第 1 轮: sendMessage 会把 sendSeq 推到 1 ---
    useAgentStore.setState({ sendSeq: 1 })
    useAgentStore.getState().upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 1, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      '第一轮回答'
    )

    // --- 用户发第 2 条消息: sendMessage 递增 sendSeq 到 2 + append userMsg ---
    useAgentStore.setState((s) => ({
      sendSeq: s.sendSeq + 1,
      messages: [
        ...s.messages,
        { eventId: 'user-2', sessionId, ts: 2, turnIndex: 0, type: 'user.text', text: '第二个问题' } as any,
      ],
    }))

    // --- 第 2 轮: 同样 blockIndex=0 / turnIndex=0 / textSegmentRev=0 的首个文本 ---
    useAgentStore.getState().upsertStreamBlock(
      'text',
      { eventId: '', sessionId, ts: 3, turnIndex: 0, type: 'assistant.text', index: 0 } as any,
      '第二轮回答'
    )

    const messages = useAgentStore.getState().messages
    const texts = messages.filter((m) => m.type === 'assistant.text')

    // 两轮回答应是两条独立 assistant.text, 内容不串
    expect(texts).toHaveLength(2)
    expect(texts[0]!.text).toBe('第一轮回答')
    expect(texts[1]!.text).toBe('第二轮回答')
    expect(texts[0]!.eventId).not.toBe(texts[1]!.eventId)

    // 顺序: 第一轮回答 → 用户消息 → 第二轮回答
    // (第二轮文本落在 userMsg 之后, 而非被塞回上一轮气泡)
    expect(messages.map((m) => m.type)).toEqual([
      'assistant.text',
      'user.text',
      'assistant.text',
    ])
  })
})

// 回归: tool_use:error 翻译成 runtime.error 时丢失 toolUseId, 前端只
// setStatus('error') 不动具体工具 → ToolCallBlock 卡在 "调用中" 永远不变.
// server 修复后, runtime.error 携带 toolUseId, 前端把它 upsert 成
// tool_use:error, ToolCallBlock 切到 "错误".
describe('useAgentStore — runtime.error 携带 toolUseId', () => {
  beforeEach(() => {
    useAgentStore.setState({
      messages: [],
      status: 'idle',
      textSegmentRev: 0,
      segmentedToolUseIds: {},
      sendSeq: 0,
    })
  })

  it('runtime.error + toolUseId 把对应 tool_use:start upsert 成 tool_use:error', () => {
    const state = useAgentStore.getState()
    const sessionId = 'sess-err-1'

    // 1) 工具先 start (来自 runtime.tool_call)
    state.applyRuntimeEvent({
      eventId: 'tc-1',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'runtime.tool_call',
      toolUseId: 'tu_1',
      toolName: 'Bash',
      input: { command: 'ls' },
    })
    // 2) 工具抛错 (server 把 tool_use:error 翻译成 runtime.error + toolUseId)
    state.applyRuntimeEvent({
      eventId: 'err-1',
      sessionId,
      ts: 2,
      turnIndex: 0,
      type: 'runtime.error',
      error: { category: 'tool', message: 'spawn ENOENT', recoverable: false },
      toolUseId: 'tu_1',
    } as any)

    const msgs = useAgentStore.getState().messages
    // 应当只有一条工具消息, type=tool_use:error (start → error upsert 合并)
    const tools = msgs.filter((m) => m.type?.startsWith('tool_use:'))
    expect(tools).toHaveLength(1)
    expect(tools[0]!.type).toBe('tool_use:error')
    expect((tools[0] as any).toolUseId).toBe('tu_1')
    expect((tools[0] as any).error).toBe('spawn ENOENT')
    // status 也应切到 error
    expect(useAgentStore.getState().status).toBe('error')
  })

  it('runtime.error 不携带 toolUseId 时只 setStatus, 不创建工具消息', () => {
    const state = useAgentStore.getState()
    const sessionId = 'sess-err-2'

    state.applyRuntimeEvent({
      eventId: 'err-2',
      sessionId,
      ts: 1,
      turnIndex: 0,
      type: 'runtime.error',
      error: { category: 'internal', message: 'LLM provider 5xx', recoverable: false },
    })

    const msgs = useAgentStore.getState().messages
    expect(msgs).toHaveLength(0)
    expect(useAgentStore.getState().status).toBe('error')
  })
})

// 回归: 后端重复发 runtime.tool_call 到达 tool_use:done 之后 (例如 SSE 重
// 连后重发, 或 server 在 content_block_stop + tool_use:start 之间漏接导致
// 后端再补一次), 老 findIndex 只匹配 'tool_use:start' 落入新建分支, 残留
// 第二条 'tool_use:start' 与已完成的 done 条目并存 — React 用同一个 key
// (tool-${toolUseId}) 渲染两条 ToolCallBlock, UI 同时显示 "已完成"+"调用中"
// 永远卡死. 修复: findIndex 匹配任意 tool_use:*, 迟到的 tool_use:start 不
// 再覆盖已 done/error 的条目.
describe('useAgentStore — runtime.tool_call 迟到 (tool_use:done 之后)', () => {
  beforeEach(() => {
    useAgentStore.setState({
      messages: [],
      status: 'idle',
      textSegmentRev: 0,
      segmentedToolUseIds: {},
      sendSeq: 0,
    })
  })

  it('runtime.tool_call 在 tool_use:done 之后到达, 不再残留第二条 tool_use:start', () => {
    const state = useAgentStore.getState()
    const sid = 'sess-late-1'

    state.applyRuntimeEvent({
      eventId: 'a', ts: 1, sessionId: sid, turnIndex: 0,
      type: 'runtime.tool_call',
      toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' },
    })
    state.applyRuntimeEvent({
      eventId: 'b', ts: 2, sessionId: sid, turnIndex: 0,
      type: 'runtime.tool_result',
      toolUseId: 't1', output: 'ok',
    })
    // 后端 bug / SSE 重发: 在 done 之后又来一次 tool_call, 不应再覆盖
    state.applyRuntimeEvent({
      eventId: 'c', ts: 3, sessionId: sid, turnIndex: 0,
      type: 'runtime.tool_call',
      toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' },
    })

    const tools = useAgentStore.getState().messages.filter(
      (m) => (m.type as string).startsWith('tool_use:'),
    )
    expect(tools).toHaveLength(1)
    expect(tools[0]!.type).toBe('tool_use:done')
    expect((tools[0] as any).output).toBe('ok')
  })

  it('runtime.tool_call 在 tool_use:error 之后到达, 不再残留第二条 tool_use:start', () => {
    const state = useAgentStore.getState()
    const sid = 'sess-late-2'

    state.applyRuntimeEvent({
      eventId: 'a', ts: 1, sessionId: sid, turnIndex: 0,
      type: 'runtime.tool_call',
      toolUseId: 't2', toolName: 'Bash', input: { command: 'rm -rf /' },
    })
    state.applyRuntimeEvent({
      eventId: 'err', ts: 2, sessionId: sid, turnIndex: 0,
      type: 'runtime.error',
      error: { category: 'tool', message: 'permission denied', recoverable: false },
      toolUseId: 't2',
    } as any)
    state.applyRuntimeEvent({
      eventId: 'c', ts: 3, sessionId: sid, turnIndex: 0,
      type: 'runtime.tool_call',
      toolUseId: 't2', toolName: 'Bash', input: { command: 'rm -rf /' },
    })

    const tools = useAgentStore.getState().messages.filter(
      (m) => (m.type as string).startsWith('tool_use:'),
    )
    expect(tools).toHaveLength(1)
    expect(tools[0]!.type).toBe('tool_use:error')
  })

  it('正常顺序 (tool_use:done 在 tool_call 之后) 仍正确合并到一条 done', () => {
    const state = useAgentStore.getState()
    const sid = 'sess-normal'

    state.applyRuntimeEvent({
      eventId: 'a', ts: 1, sessionId: sid, turnIndex: 0,
      type: 'runtime.tool_call',
      toolUseId: 't3', toolName: 'Read', input: { path: '/tmp/x' },
    })
    state.applyRuntimeEvent({
      eventId: 'b', ts: 2, sessionId: sid, turnIndex: 0,
      type: 'runtime.tool_result',
      toolUseId: 't3', output: 'contents',
    })

    const tools = useAgentStore.getState().messages.filter(
      (m) => (m.type as string).startsWith('tool_use:'),
    )
    expect(tools).toHaveLength(1)
    expect(tools[0]!.type).toBe('tool_use:done')
  })
})

describe('useAgentStore.patchSessionModel', () => {
  let originalFetch: typeof globalThis.fetch
  let originalLocalStorage: Storage
  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalLocalStorage = globalThis.localStorage
    const store: Record<string, string> = {}
    globalThis.localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { for (const k of Object.keys(store)) delete store[k] },
      key: (i: number) => Object.keys(store)[i] ?? null,
      get length() { return Object.keys(store).length },
    } as Storage
    useAgentStore.setState({ sessions: [], availableModels: [] })
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.localStorage = originalLocalStorage
  })

  it('optimistically updates local session.model and POSTs to PATCH endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    })
    globalThis.fetch = fetchMock as any

    useAgentStore.setState({
      sessions: [{
        transcriptId: 'sess-1',
        title: 'old',
        updatedAt: 1,
        cwd: '/x',
      }],
    })

    await useAgentStore.getState().patchSessionModel('sess-1', 'MiniMax-M3')

    const updated = useAgentStore.getState().sessions[0]
    expect(updated!.model).toBe('MiniMax-M3')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/agent/sessions/sess-1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'MiniMax-M3' })
  })

  it('reverts optimistic update when PATCH returns non-OK', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    })
    globalThis.fetch = fetchMock as any

    useAgentStore.setState({
      sessions: [{
        transcriptId: 'sess-1',
        title: 'old',
        updatedAt: 1,
        // No model field set yet.
      }],
    })

    await useAgentStore.getState().patchSessionModel('sess-1', 'MiniMax-M3')

    const after = useAgentStore.getState().sessions[0]
    expect(after!.model).toBeUndefined() // revert worked
  })
})

describe('useAgentStore.loadSessions', () => {
  let originalFetch: typeof globalThis.fetch
  let originalLocalStorage: Storage
  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalLocalStorage = globalThis.localStorage
    const store: Record<string, string> = {}
    globalThis.localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { for (const k of Object.keys(store)) delete store[k] },
      key: (i: number) => Object.keys(store)[i] ?? null,
      get length() { return Object.keys(store).length },
    } as Storage
    useAgentStore.setState({ sessions: [], availableModels: [] })
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.localStorage = originalLocalStorage
  })

  it('populates availableModels from /api/agent/settings response', async () => {
    const models: ModelEntry[] = [
      { alias: 'M3', model: 'MiniMax-M3' },
      { alias: 'haiku', model: 'MiniMax-M2.7-highspeed' },
    ]
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/agent/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ defaultModel: 'MiniMax-M3', baseURL: null, models }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ sessions: [] }),
      } as Response)
    }) as any

    await useAgentStore.getState().loadSessions()

    expect(useAgentStore.getState().availableModels).toEqual(models)
  })

  it('keeps availableModels empty when settings fetch fails', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/agent/settings')) {
        return Promise.reject(new Error('boom'))
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ sessions: [] }),
      } as Response)
    }) as any

    await useAgentStore.getState().loadSessions()

    expect(useAgentStore.getState().availableModels).toEqual([])
  })
})
