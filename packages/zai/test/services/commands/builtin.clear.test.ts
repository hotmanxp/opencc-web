import { describe, expect, it, beforeEach, vi } from 'vitest'
import { setCommandRegistry, getCommandRegistry } from '@zn-ai/zai-agent-core'
import { clearCommand } from '../../../src/server/services/commands/builtin/clear.js'

const runtimeMock = vi.hoisted(() => ({
  sessionId: null as string | null,
  remove: vi.fn(() => Promise.resolve()),
  abort: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getTranscriptStore: () => ({ remove: runtimeMock.remove }),
  getCurrentSessionId: () => runtimeMock.sessionId,
  getRuntime: () => ({}),
  abortAgentSession: runtimeMock.abort,
}))

beforeEach(() => {
  setCommandRegistry(null)
  runtimeMock.sessionId = null
  runtimeMock.remove.mockClear()
  runtimeMock.abort.mockClear()
})

describe('clearCommand', () => {
  it('removes transcript and returns {kind:"cleared"}', async () => {
    getCommandRegistry().register(clearCommand)
    const { clearCommand: fresh } = await import('../../../src/server/services/commands/builtin/clear.js')
    const result = await fresh.call('whatever', { cwd: '/x', dataDir: '/d' })
    expect(result).toEqual({ kind: 'cleared' })
    expect(runtimeMock.remove).toHaveBeenCalledTimes(0) // sessionId is null
    expect(runtimeMock.abort).toHaveBeenCalledTimes(0)
  })

  it('aborts active session and removes transcript when sessionId present', async () => {
    runtimeMock.sessionId = 'sess-1'
    const { clearCommand: fresh } = await import('../../../src/server/services/commands/builtin/clear.js')
    const result = await fresh.call('', { cwd: '/x', dataDir: '/d' })
    expect(result).toEqual({ kind: 'cleared' })
    expect(runtimeMock.abort).toHaveBeenCalled()
    expect(runtimeMock.remove).toHaveBeenCalledWith('sess-1')
  })
})
