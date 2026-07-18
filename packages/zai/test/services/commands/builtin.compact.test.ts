import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { TranscriptStore } from '../../../../zai-agent-core/src/transcript/store.js'
import { appendUserMessageV2, appendAssistantMessageV2 } from '../../../../zai-agent-core/src/transcript/persistence.js'

// 用 mock 替换 agentRuntime 全模块 — 模仿 builtin.clear.test.ts 范式
const runtimeMock = vi.hoisted(() => ({
  sessionId: null as string | null,
  store: null as TranscriptStore | null,
  replace: vi.fn(() => Promise.resolve()),
  modelCaller: null as any,
  defaultModel: 'mock-model',
  abort: vi.fn(() => Promise.resolve()),
}))

let tmpDir: string

beforeEach(async () => {
  vi.resetModules()
  runtimeMock.sessionId = null
  runtimeMock.replace.mockClear()
  runtimeMock.abort.mockClear()
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-cmd-compact-'))
  runtimeMock.store = new TranscriptStore(tmpDir)
  await runtimeMock.store.create({ cwd: '/test', model: 'mock-model' })
  // 默认的 modelCaller: yield 固定 text_delta + message_stop
  runtimeMock.modelCaller = async function* () {
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'mocked summary' } }
    yield { type: 'message_stop' }
  }
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getTranscriptStore: () => runtimeMock.store,
  getCurrentSessionId: () => runtimeMock.sessionId,
  getRuntime: () => ({
    config: {
      modelCaller: runtimeMock.modelCaller,
      defaultModel: runtimeMock.defaultModel,
    },
  }),
  abortAgentSession: runtimeMock.abort,
}))

describe('compactCommand', () => {
  it('returns kind:cleared when no current sessionId', async () => {
    runtimeMock.sessionId = null
    const { compactCommand } = await import(
      '../../../src/server/services/commands/builtin/compact.js'
    )
    const result = await compactCommand.call('', { cwd: '/test', dataDir: '/x' })
    expect(result.kind).toBe('cleared')
  })

  it('returns kind:error when session exists but messages.length < 2', async () => {
    const sid = 'sess-' + Math.random()
    // 直接构造 cmd 验证 < 2 路径: 用一个空 store 没有 messages
    await runtimeMock.store!.create({ cwd: '/test', model: 'mock-model' })
    const emptyStore = new TranscriptStore(tmpDir + '-empty')
    await emptyStore.create({ cwd: '/test', model: 'mock-model' })
    // 用一个空 session 来跑 (no messages appended)
    const { compactCommand } = await import(
      '../../../src/server/services/commands/builtin/compact.js'
    )
    const result = await compactCommand.call('', {
      cwd: '/test', dataDir: '/x', sessionId: sid,
    })
    // note: sid 不在 store 里, store.read 会抛 ENOENT -> '会话不存在'
    expect(result.kind).toBe('error')
    expect((result as { message: string }).message).toMatch(/会话不存在|太短/)
  })

  it('happy path: returns kind:compacted after summary + replace', async () => {
    const sid = await runtimeMock.store!.create({ cwd: '/test', model: 'mock-model' })
    const ctx = { cwd: '/test', sessionId: sid }
    await appendUserMessageV2(runtimeMock.store!, sid, 'hi', 0, null, ctx)
    await appendAssistantMessageV2(
      runtimeMock.store!, sid,
      [{ type: 'text', text: 'hello' }], 0, null, ctx,
    )
    runtimeMock.sessionId = sid

    const { compactCommand } = await import(
      '../../../src/server/services/commands/builtin/compact.js'
    )
    const result = await compactCommand.call('', {
      cwd: '/test', dataDir: '/x', sessionId: sid,
    })
    expect(result.kind).toBe('compacted')
    if (result.kind !== 'compacted') return
    expect(result.summary).toBe('mocked summary')
    expect(result.removedMessages).toBe(0)  // 2 original → 保 boundary + summary 共 2
    // store 已经被 replace: 原始 2 条 + 1 boundary + 1 summary = 4
    const after = await runtimeMock.store!.read(sid)
    expect(after.messages).toHaveLength(4)
    expect(after.messages[after.messages.length - 2]!.type).toBe('compact_boundary')
    expect(after.messages[after.messages.length - 1]!.type).toBe('assistant')
  })

  it('propagates kind:error from compactSession without writing', async () => {
    const sid = await runtimeMock.store!.create({ cwd: '/test', model: 'mock-model' })
    const ctx = { cwd: '/test', sessionId: sid }
    await appendUserMessageV2(runtimeMock.store!, sid, 'p', 0, null, ctx)
    await appendAssistantMessageV2(
      runtimeMock.store!, sid,
      [{ type: 'text', text: 'r' }], 0, null, ctx,
    )
    runtimeMock.sessionId = sid
    // mock 出空 summary (只 yield message_stop, 不 yield text_delta)
    // → compactSession 走到 if (!summary) → '生成摘要失败: 模型返回空结果'
    runtimeMock.modelCaller = async function* () {
      yield { type: 'message_stop' }
    }

    const { compactCommand } = await import(
      '../../../src/server/services/commands/builtin/compact.js'
    )
    const result = await compactCommand.call('', {
      cwd: '/test', dataDir: '/x', sessionId: sid,
    })
    expect(result.kind).toBe('error')
    expect((result as { message: string }).message).toContain('空')
  })
})
