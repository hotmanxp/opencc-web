import { describe, it, expect, vi, beforeEach } from 'vitest'

// Track the operations clearCommand performs against the transcript store
// and agent runtime. Each test installs a fresh spy so we can assert "no
// transcript file is removed after /clear" — the post-condition that keeps
// the front-end sessionId resolvable on the next /agent/prompt call.
interface StoreCall {
  method: 'remove' | 'replace' | 'mutateMessages' | 'append' | 'create' | 'patch'
  transcriptId?: string
  payload?: unknown
}

const storeCalls: StoreCall[] = []
let mockTranscript: { messages: unknown[]; meta: { cwd: string } } | null = null
let mockCurrentSessionId: string | null = 'sess-existing'
let abortCalled = false

vi.mock('../../src/server/services/agentRuntime.js', () => ({
  abortAgentSession: vi.fn(async () => {
    abortCalled = true
  }),
  getCurrentSessionId: () => mockCurrentSessionId,
  getTranscriptStore: () => ({
    async read(transcriptId: string) {
      if (!mockTranscript) throw new Error(`ENOENT: ${transcriptId}`)
      return {
        version: 1,
        transcriptId,
        meta: { ...mockTranscript.meta, createdAt: 0, updatedAt: 0, model: 'unknown' },
        messages: mockTranscript.messages,
      }
    },
    async remove(transcriptId: string) {
      storeCalls.push({ method: 'remove', transcriptId })
      mockTranscript = null
    },
    async replace(transcriptId: string, messages: unknown[]) {
      storeCalls.push({ method: 'replace', transcriptId, payload: messages })
      if (mockTranscript) mockTranscript.messages = messages
    },
    async create() {
      throw new Error('not used in this test')
    },
    async append() {
      throw new Error('not used in this test')
    },
    async patch() {
      throw new Error('not used in this test')
    },
    async list() {
      return []
    },
  }),
}))

// clearMemoryCache 是 zai-agent-core 的 side-effect flush,与本测试无关。
// 把它替换成 no-op,避免测试加载整个 runtime module.
vi.mock('@zn-ai/zai-agent-core', () => ({
  clearMemoryCache: () => {},
}))

import { clearCommand } from '../../src/server/services/commands/builtin/clear.js'

beforeEach(() => {
  storeCalls.length = 0
  abortCalled = false
  mockCurrentSessionId = 'sess-existing'
  mockTranscript = {
    messages: [
      { role: 'user', content: 'old turn 1' },
      { role: 'assistant', content: 'old turn 2' },
    ],
    meta: { cwd: '/tmp' },
  }
})

describe('clearCommand — /clear should preserve transcript file so next /agent/prompt can resume', () => {
  it('does NOT delete the transcript file (no store.remove call)', async () => {
    await clearCommand.call('', {
      cwd: '/tmp',
      dataDir: '',
      sessionId: 'sess-existing',
    } as any)
    const removes = storeCalls.filter((c) => c.method === 'remove')
    expect(removes).toEqual([])
  })

  it('emits transcript survive: a subsequent read with the same sessionId still succeeds', async () => {
    await clearCommand.call('', {
      cwd: '/tmp',
      dataDir: '',
      sessionId: 'sess-existing',
    } as any)
    // Next /agent/prompt will call store.read(sid). If clear nuked the file,
    // this throws ENOENT → 404 'Session not found'. The contract of /clear
    // is "清屏但保留 session", so this read must succeed.
    const { getTranscriptStore } = await import(
      '../../src/server/services/agentRuntime.js'
    )
    const t = await getTranscriptStore().read('sess-existing')
    expect(t.transcriptId).toBe('sess-existing')
    expect(Array.isArray(t.messages)).toBe(true)
  })

  it('emits messages drained: post-clear transcript.messages is empty (or just a system marker)', async () => {
    await clearCommand.call('', {
      cwd: '/tmp',
      dataDir: '',
      sessionId: 'sess-existing',
    } as any)
    const { getTranscriptStore } = await import(
      '../../src/server/services/agentRuntime.js'
    )
    const t = await getTranscriptStore().read('sess-existing')
    expect(t.messages.length).toBe(0)
  })

  it('still aborts any in-flight runtime before clearing (preserves the abort-on-clear UX)', async () => {
    await clearCommand.call('', {
      cwd: '/tmp',
      dataDir: '',
      sessionId: 'sess-existing',
    } as any)
    expect(abortCalled).toBe(true)
  })

  it('no-op when there is no current session', async () => {
    mockCurrentSessionId = null
    await clearCommand.call('', { cwd: '/tmp', dataDir: '' } as any)
    expect(storeCalls).toEqual([])
    expect(abortCalled).toBe(false)
  })
})
