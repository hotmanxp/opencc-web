import { describe, it, expect, vi } from 'vitest'

// Mock @zn-ai/zai-agent-core
vi.mock('@zn-ai/zai-agent-core', () => {
  const mockSessions: Array<{ transcriptId: string }> = []
  return {
    DefaultAgentRuntime: vi.fn().mockImplementation(function () {
      this.listSessions = vi.fn().mockResolvedValue(mockSessions)
    }),
    resolveDataDir: vi.fn().mockReturnValue('/tmp/.zai-test'),
  }
})

describe('agentRuntime', () => {
  it('initAgentRuntime is idempotent and getRuntime returns runtime', async () => {
    const { initAgentRuntime, getRuntime } = await import('../../src/server/services/agentRuntime.js')
    initAgentRuntime()
    initAgentRuntime() // second call should be no-op
    const rt = getRuntime()
    expect(rt).toBeDefined()
    expect(typeof rt.listSessions).toBe('function')
  })

  it('getOrCreateAgentSession returns a session id', async () => {
    const { initAgentRuntime, getOrCreateAgentSession } = await import('../../src/server/services/agentRuntime.js')
    initAgentRuntime()
    const sessionId = await getOrCreateAgentSession()
    expect(sessionId).toBeDefined()
    expect(typeof sessionId).toBe('string')
    expect(sessionId.length).toBeGreaterThan(0)
  })

  it('getOrCreateAgentSession returns the same id on subsequent calls', async () => {
    const { initAgentRuntime, getOrCreateAgentSession } = await import('../../src/server/services/agentRuntime.js')
    initAgentRuntime()
    const a = await getOrCreateAgentSession()
    const b = await getOrCreateAgentSession()
    expect(a).toBe(b)
  })
})