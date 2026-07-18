import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { TranscriptStore } from '../../src/transcript/store.js'
import { compactSession } from '../../src/runtime/compactService.js'
import { appendUserMessageV2, appendAssistantMessageV2 } from '../../src/transcript/persistence.js'

let tmpDir: string
let store: TranscriptStore
let sessionId: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-compact-'))
  store = new TranscriptStore(tmpDir)
  sessionId = await store.create({ cwd: '/test', model: 'mock-model' })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('compactSession', () => {
  it('happy path: appends boundary + summary, returns compacted result', async () => {
    const ctx = { cwd: '/test', sessionId }
    await appendUserMessageV2(store, sessionId, 'first prompt', 0, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'first reply' }], 0, null, ctx)
    await appendUserMessageV2(store, sessionId, 'second prompt', 1, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'second reply' }], 1, null, ctx)

    const calls: Array<{ messages: unknown[]; tools: unknown[] }> = []
    const mockModelCaller = async function* (req: any) {
      calls.push({ messages: req.messages, tools: req.tools })
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'summary text' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    } as any

    const result = await compactSession({
      store,
      sessionId,
      modelCaller: mockModelCaller,
      cwd: '/test',
    })

    expect(result.kind).toBe('compacted')
    if (result.kind !== 'compacted') return
    expect(result.summary).toBe('summary text')
    expect(result.newMessages).toHaveLength(6)  // 4 original + boundary + summary
    expect(result.newMessages[4].type).toBe('compact_boundary')
    expect(result.newMessages[5].type).toBe('assistant')
    expect((result.newMessages[5].message as any).content[0].text).toBe('summary text')
    // 工具列表应为空, 不允许压缩时调工具
    expect((calls[0].tools as any[]).length).toBe(0)
  })

  it('rejects transcripts with < 2 messages', async () => {
    const ctx = { cwd: '/test', sessionId }
    await appendUserMessageV2(store, sessionId, 'only one prompt', 0, null, ctx)

    const mockModelCaller = async function* () {
      yield { type: 'message_stop' }
    } as any

    const result = await compactSession({
      store, sessionId, modelCaller: mockModelCaller, cwd: '/test',
    })
    expect(result.kind).toBe('error')
    expect((result as { message: string }).message).toContain('太短')
  })

  it('returns kind:error when model returns empty summary', async () => {
    const ctx = { cwd: '/test', sessionId }
    await appendUserMessageV2(store, sessionId, 'prompt 1', 0, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'reply 1' }], 0, null, ctx)

    const mockModelCaller = async function* () {
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '   ' } }
      yield { type: 'message_stop' }
    } as any

    const result = await compactSession({
      store, sessionId, modelCaller: mockModelCaller, cwd: '/test',
    })
    expect(result.kind).toBe('error')
    expect((result as { message: string }).message).toContain('空')
  })

  it('returns kind:error when modelCaller throws', async () => {
    const ctx = { cwd: '/test', sessionId }
    await appendUserMessageV2(store, sessionId, 'p1', 0, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'r1' }], 0, null, ctx)

    const throwingCaller = async function* () {
      throw new Error('SDK timeout')
    } as any

    const result = await compactSession({
      store, sessionId, modelCaller: throwingCaller, cwd: '/test',
    })
    expect(result.kind).toBe('error')
    expect((result as { message: string }).message).toContain('生成摘要失败')
    // service 不写盘 — 原始 transcript 应仍是 2 条
    const afterRead = await store.read(sessionId)
    expect(afterRead.messages).toHaveLength(2)
  })

  it('preserves uuid chain: boundary.parentUuid = lastOriginal, summary.parentUuid = boundary', async () => {
    const ctx = { cwd: '/test', sessionId }
    await appendUserMessageV2(store, sessionId, 'p1', 0, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'r1' }], 0, null, ctx)
    const before = await store.read(sessionId)
    const lastOriginalUuid = before.messages[before.messages.length - 1]!.uuid

    const mockModelCaller = async function* () {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sum' } }
      yield { type: 'message_stop' }
    } as any

    const result = await compactSession({
      store, sessionId, modelCaller: mockModelCaller, cwd: '/test',
    })
    expect(result.kind).toBe('compacted')
    if (result.kind !== 'compacted') return
    const boundary = result.newMessages[result.newMessages.length - 2]!
    const summary = result.newMessages[result.newMessages.length - 1]!
    expect(boundary.type).toBe('compact_boundary')
    expect(boundary.parentUuid).toBe(lastOriginalUuid)
    expect(summary.type).toBe('assistant')
    expect(summary.parentUuid).toBe(boundary.uuid)
    expect(summary.uuid).not.toBe(boundary.uuid)
  })

  it('drops thinking blocks in compact input markdown', async () => {
    const ctx = { cwd: '/test', sessionId }
    await appendUserMessageV2(store, sessionId, 'tell me', 0, null, ctx)
    await appendAssistantMessageV2(
      store, sessionId,
      [{ type: 'thinking', thinking: 'secret reasoning path' }, { type: 'text', text: 'answer' }],
      0, null, ctx,
    )

    const capturedMarkdown: string[] = []
    const captureCaller = async function* (req: any) {
      capturedMarkdown.push(String(req.messages[0].content))
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sum' } }
      yield { type: 'message_stop' }
    } as any

    await compactSession({
      store, sessionId, modelCaller: captureCaller, cwd: '/test',
    })
    expect(capturedMarkdown[0]).not.toContain('secret reasoning path')
    expect(capturedMarkdown[0]).toContain('answer')
  })

  it('truncates tool_result content to 500 chars in compact input', async () => {
    const ctx = { cwd: '/test', sessionId }
    await appendUserMessageV2(store, sessionId, 'big output', 0, null, ctx)
    const huge = 'x'.repeat(800)
    const { appendToolResult } = await import('../../src/transcript/persistence.js')
    const lastRead = await store.read(sessionId)
    const parent = lastRead.messages[lastRead.messages.length - 1]!.uuid
    await appendToolResult(
      store, sessionId,
      { tool_use_id: 'tu1', content: huge, is_error: false },
      0, parent, '/test',
    )
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'ok' }], 0, null, ctx)

    const captured: string[] = []
    const captureCaller = async function* (req: any) {
      captured.push(String(req.messages[0].content))
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sum' } }
      yield { type: 'message_stop' }
    } as any

    await compactSession({
      store, sessionId, modelCaller: captureCaller, cwd: '/test',
    })
    expect(captured[0]).toContain('...(truncated)')
    expect(captured[0]).not.toContain('x'.repeat(600))
  })
})
