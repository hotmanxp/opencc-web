import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { TranscriptStore } from '../../../src/transcript/store.js'
import { compactSession } from '../../../src/runtime/compact/index.js'
import { appendUserMessageV2, appendAssistantMessageV2 } from '../../../src/transcript/persistence.js'

let tmpDir: string
let store: TranscriptStore
let sessionId: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-cmd-v2-'))
  store = new TranscriptStore(tmpDir)
  sessionId = await store.create({ cwd: '/test', model: 'MiniMax-M3' }, { cwd: '/test' })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('compactSession v2 集成', () => {
  it('PTL 自愈链:首次 PTL → 削头 → 第二次成功', async () => {
    const ctx = { cwd: '/test', sessionId }
    await appendUserMessageV2(store, sessionId, 'p1', 0, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'r1' }], 0, null, ctx)
    await appendUserMessageV2(store, sessionId, 'p2', 1, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'r2' }], 1, null, ctx)
    await appendUserMessageV2(store, sessionId, 'p3', 2, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'r3' }], 2, null, ctx)
    await appendUserMessageV2(store, sessionId, 'p4', 3, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'r4' }], 3, null, ctx)

    let calls = 0
    const mock = (async function* () {
      calls++
      if (calls === 1) {
        throw Object.assign(new Error('prompt_too_long'), {
          code: 'prompt_too_long',
          // 100_000: gap=72000 > 50k headroom threshold, truncateHeadForPTLRetry 返回非 null → 重试
          ptlResponse: { usage: { output_tokens: 100_000 } },
        })
      }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sum' } }
      yield { type: 'message_stop' }
    }) as any

    const result = await compactSession({
      store, sessionId, modelCaller: mock, cwd: '/test', model: 'MiniMax-M3', providerKind: 'openai',
    })
    expect(result.kind).toBe('compacted')
    expect(calls).toBe(2)
  })

  it('dual path:providerKind=anthropic / openai / custom 都成功走通', async () => {
    const mock = (async function* () {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 's' } }
      yield { type: 'message_stop' }
    }) as any

    for (const pk of ['anthropic', 'openai', 'custom']) {
      const sid = await store.create({ cwd: '/test', model: 'MiniMax-M3' }, { cwd: '/test' })
      const ctx = { cwd: '/test', sessionId: sid }
      await appendUserMessageV2(store, sid, 'p', 0, null, ctx)
      await appendAssistantMessageV2(store, sid, [{ type: 'text', text: 'r' }], 0, null, ctx)
      const result = await compactSession({
        store, sessionId: sid, modelCaller: mock, cwd: '/test', model: 'MiniMax-M3', providerKind: pk,
      })
      expect(result.kind).toBe('compacted')
    }
  })

  it('hook no-op 不阻塞(2 原始 + boundary + summary)', async () => {
    const ctx = { cwd: '/test', sessionId }
    await appendUserMessageV2(store, sessionId, 'p', 0, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'r' }], 0, null, ctx)

    const mock = (async function* () {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 's' } }
      yield { type: 'message_stop' }
    }) as any

    const result = await compactSession({
      store, sessionId, modelCaller: mock, cwd: '/test',
    })
    expect(result.kind).toBe('compacted')
    if (result.kind === 'compacted') {
      expect(result.newMessages.length).toBe(4)
    }
  })

  it('preCompactTokenCount 真实估算(不再占位)', async () => {
    const ctx = { cwd: '/test', sessionId }
    await appendUserMessageV2(store, sessionId, '一二三四五六七八九', 0, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'hi' }], 0, null, ctx)

    const mock = (async function* () {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 's' } }
      yield { type: 'message_stop' }
    }) as any

    const result = await compactSession({
      store, sessionId, modelCaller: mock, cwd: '/test',
    })
    expect(result.kind).toBe('compacted')
    if (result.kind === 'compacted') {
      expect(result.newMessages.length).toBe(4)
    }
  })
})
