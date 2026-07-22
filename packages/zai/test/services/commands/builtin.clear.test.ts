import { describe, expect, it, beforeEach, vi } from 'vitest'
import { setCommandRegistry, getCommandRegistry } from '@zn-ai/zai-agent-core'
import { clearCommand } from '../../../src/server/services/commands/builtin/clear.js'

const runtimeMock = vi.hoisted(() => ({
  sessionId: null as string | null,
  replace: vi.fn(() => Promise.resolve()),
  abort: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getTranscriptStore: () => ({ replace: runtimeMock.replace }),
  getCurrentSessionId: () => runtimeMock.sessionId,
  getRuntime: () => ({}),
  abortAgentSession: runtimeMock.abort,
}))

beforeEach(() => {
  setCommandRegistry(null)
  runtimeMock.sessionId = null
  runtimeMock.replace.mockClear()
  runtimeMock.abort.mockClear()
})

describe('clearCommand', () => {
  it('no-op when there is no current session and no context.sessionId', async () => {
    getCommandRegistry().register(clearCommand)
    const { clearCommand: fresh } = await import('../../../src/server/services/commands/builtin/clear.js')
    const result = await fresh.call('whatever', { cwd: '/x', dataDir: '/d' })
    expect(result).toEqual({ kind: 'cleared' })
    expect(runtimeMock.replace).toHaveBeenCalledTimes(0)
    expect(runtimeMock.abort).toHaveBeenCalledTimes(0)
  })

  it('aborts and replaces transcript.messages with [] (not remove) when sessionId present via context', async () => {
    // 修复后契约: /clear 必须保留 transcript 文件,只清空 messages。
    // 旧实现调 store.remove 会导致下一次 POST /agent/prompt 携带同 sid
    // → server read() ENOENT → 404 'Session not found'。
    const { clearCommand: fresh } = await import('../../../src/server/services/commands/builtin/clear.js')
    const result = await fresh.call('', {
      cwd: '/x',
      dataDir: '/d',
      sessionId: 'sess-1',
    })
    expect(result).toEqual({ kind: 'cleared' })
    expect(runtimeMock.abort).toHaveBeenCalled()
    // 关键: 必须是 replace(保留文件),不允许 remove
    expect(runtimeMock.replace).toHaveBeenCalledWith('sess-1', [])
  })

  it('falls back to getCurrentSessionId() when context.sessionId missing', async () => {
    runtimeMock.sessionId = 'sess-fallback'
    const { clearCommand: fresh } = await import('../../../src/server/services/commands/builtin/clear.js')
    const result = await fresh.call('', { cwd: '/x', dataDir: '/d' })
    expect(result).toEqual({ kind: 'cleared' })
    expect(runtimeMock.replace).toHaveBeenCalledWith('sess-fallback', [])
  })
})