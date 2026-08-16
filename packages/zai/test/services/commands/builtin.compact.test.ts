import { describe, expect, it, beforeEach, vi } from 'vitest'

// 把 queryModelWithStreaming 整体替换成可控 stream — 当前 compactCommand
// 直接走 vendor 内置 query 路径 (注释见 compact.ts:106-113),不再依赖
// compat shim 的 modelCaller 注入。
const queryMock = vi.hoisted(() => ({
  /**
   * controlled stream 内容: 数组里每个元素是 compactCommand 会消费的
   * 一个 stream event 形状。默认 yield 一段文本 + message_stop,
   * 改这个数组可模拟超时/空响应等失败路径。
   */
  events: [
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'mocked summary' },
      },
    },
    { type: 'message_stop' },
  ] as unknown[],
}))

interface TranscriptMessage {
  type: string
  uuid?: string
  message?: { content: unknown; role?: string }
  [k: string]: unknown
}

interface TranscriptLike {
  messages: TranscriptMessage[]
  read: (sid: string, opts: { cwd: string }) => Promise<{ messages: TranscriptMessage[] }>
  replace: ReturnType<typeof vi.fn>
}

const storeMock = vi.hoisted(() => {
  // sessions[sid] = 当前 transcript 的 messages 数组 — store.read 返回
  // 这个数组的浅拷贝,store.replace 整体覆盖它。测试用例直接 mutate
  // sessions[sid] 就能预设 transcript 状态。
  const sessions = new Map<string, TranscriptMessage[]>()
  const replace = vi.fn(
    async (sid: string, messages: unknown) => {
      sessions.set(sid, Array.isArray(messages) ? (messages as TranscriptMessage[]) : [])
      return undefined
    },
  )
  const read = async (sid: string) => ({ messages: [...(sessions.get(sid) ?? [])] })
  const api: TranscriptLike = { messages: [], read, replace }
  return { sessions, api, replace, read }
})

const runtimeMock = vi.hoisted(() => ({
  sessionId: null as string | null,
}))

beforeEach(() => {
  vi.resetModules()
  queryMock.events = [
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'mocked summary' },
      },
    },
    { type: 'message_stop' },
  ]
  storeMock.sessions.clear()
  storeMock.replace.mockClear()
  runtimeMock.sessionId = null
})

vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getTranscriptStore: () => storeMock.api,
  getCurrentSessionId: () => runtimeMock.sessionId,
  getRuntime: () => ({ config: {} }),
  abortAgentSession: () => Promise.resolve(),
}))

vi.mock('@zn-ai/zn-agent-core', async () => {
  const actual = await vi.importActual<typeof import('@zn-ai/zn-agent-core')>(
    '@zn-ai/zn-agent-core',
  )
  return {
    ...actual,
    queryModelWithStreaming: () => ({
      // compactCommand 用 for-await-of 消费 stream — async iterable 即可
      [Symbol.asyncIterator]() {
        let i = 0
        return {
          next: () => {
            if (i >= queryMock.events.length) {
              return Promise.resolve({ value: undefined, done: true as const })
            }
            return Promise.resolve({
              value: queryMock.events[i++],
              done: false as const,
            })
          },
        }
      },
    }),
  }
})

function seedSixMessages(sid: string): void {
  storeMock.sessions.set(sid, [
    { type: 'session-meta', uuid: 'meta-1' },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first user msg' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'first assistant reply' }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second user msg' } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'second assistant reply' }] } },
    { type: 'user', uuid: 'u3', message: { role: 'user', content: 'third user msg (most recent)' } },
  ])
}

describe('compactCommand — transcript rewriting', () => {
  it('replaces transcript with [boundary, summary, ...last 2 user/assistant] (修复后契约)', async () => {
    const sid = 'sess-fix-1'
    seedSixMessages(sid)
    runtimeMock.sessionId = sid

    const { compactCommand } = await import(
      '../../../src/server/services/commands/builtin/compact.js'
    )
    const result = await compactCommand.call('', {
      cwd: '/test',
      dataDir: '/d',
      sessionId: sid,
    })

    expect(result.kind).toBe('compacted')
    if (result.kind !== 'compacted') return
    expect(result.summary).toBe('mocked summary')
    // 6 原始 → 保留最近 2 条 user/assistant → removedMessages = 4
    expect(result.removedMessages).toBe(4)

    // 关键: store.replace() 必须被调用,且参数是 [boundary, summary, kept...]
    // 不是 [...original, boundary, summary]
    expect(storeMock.replace).toHaveBeenCalledTimes(1)
    const [calledSid, calledMessages] = storeMock.replace.mock.calls[0] as [string, unknown[]]
    expect(calledSid).toBe(sid)
    expect(Array.isArray(calledMessages)).toBe(true)
    expect(calledMessages).toHaveLength(4)

    const types = (calledMessages as TranscriptMessage[]).map((m) => m.type)
    expect(types).toEqual([
      'compact_boundary',
      'assistant', // summary
      'assistant', // 倒数第二条 user/assistant (a2 "second assistant reply")
      'user',      // 最后一条 user/assistant (u3 "third user msg (most recent)")
    ])

    // summary 必须含原始 'mocked summary' 文本
    const summary = (calledMessages as TranscriptMessage[])[1]!
    expect(JSON.stringify(summary.message?.content)).toContain('mocked summary')
  })

  it('keeps only the single user/assistant entry when fewer than 2 exist', async () => {
    const sid = 'sess-fix-2'
    // 2 条 total messages (>=2 触发压缩), 但 user/assistant 只有 1 条 —
    // 验证"少于 2 就少保留"的边界。
    storeMock.sessions.set(sid, [
      { type: 'session-meta', uuid: 'meta-1' },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'only assistant' }] } },
    ])
    runtimeMock.sessionId = sid

    const { compactCommand } = await import(
      '../../../src/server/services/commands/builtin/compact.js'
    )
    const result = await compactCommand.call('', {
      cwd: '/test',
      dataDir: '/d',
      sessionId: sid,
    })

    expect(result.kind).toBe('compacted')
    if (result.kind !== 'compacted') return
    // 2 原始 - 保留 1 条 = removedMessages = 1
    expect(result.removedMessages).toBe(1)

    const [, calledMessages] = storeMock.replace.mock.calls[0] as [string, unknown[]]
    expect(calledMessages).toHaveLength(3) // boundary + summary + 1 原始
    expect((calledMessages as TranscriptMessage[]).map((m) => m.type)).toEqual([
      'compact_boundary',
      'assistant',
      'assistant',
    ])
  })

  it('returns kind:error without calling store.replace when transcript has < 2 messages', async () => {
    const sid = 'sess-fix-3'
    storeMock.sessions.set(sid, [{ type: 'session-meta', uuid: 'meta-1' }])
    runtimeMock.sessionId = sid

    const { compactCommand } = await import(
      '../../../src/server/services/commands/builtin/compact.js'
    )
    const result = await compactCommand.call('', {
      cwd: '/test',
      dataDir: '/d',
      sessionId: sid,
    })

    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.message).toMatch(/太短/)

    // 关键: < 2 路径不能调 replace,transcript 保持原状
    expect(storeMock.replace).not.toHaveBeenCalled()
  })

  it('returns kind:error (空结果) without mutating transcript', async () => {
    const sid = 'sess-fix-4'
    seedSixMessages(sid)
    runtimeMock.sessionId = sid

    // mock 出空 summary: 只有 message_stop, 没有 text_delta
    queryMock.events = [{ type: 'message_stop' }]

    const { compactCommand } = await import(
      '../../../src/server/services/commands/builtin/compact.js'
    )
    const result = await compactCommand.call('', {
      cwd: '/test',
      dataDir: '/d',
      sessionId: sid,
    })

    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.message).toContain('空')

    // 关键: 空结果不能写盘
    expect(storeMock.replace).not.toHaveBeenCalled()
  })
})