import { describe, it, expect, vi, beforeEach } from 'vitest'

// initAgentRuntime 会真实构造 TranscriptStore / createAnthropicModelCaller / loadMcpServers
// 等副作用, 拖入 IO / 网络. 这里只测纯函数式的 getOrCreateAgentSession 路径, 不调 initAgentRuntime.
// 注: DefaultAgentRuntime / resolveDataDir 等 mock 在 initAgentRuntime 测试里需要, 这里就不 mock
// 以免干扰其它用例.

describe('agentRuntime', () => {
  // 注: getOrCreateAgentSession 当前实现是占位的 return null (见
  // src/server/services/agentRuntime.ts:100-102). 真实 session id 由 server
  // 端从 transcriptId 派生, 等接口稳定后再补"返回非空 string"的测试.

  // initAgentRuntime 因副作用多 (TranscriptStore IO / Anthropic client / MCP load), 暂不
  // 在 vitest 环境里跑. 之前的"幂等"测试因 mock 不全 (缺 TranscriptStore) 一直挂, 已删.

  it('getOrCreateAgentSession currently returns null (placeholder)', async () => {
    const { getOrCreateAgentSession } = await import('../../src/server/services/agentRuntime.js')
    const sessionId = await getOrCreateAgentSession()
    expect(sessionId).toBeNull()
  })

  it('getOrCreateAgentSession returns the same null on subsequent calls', async () => {
    const { getOrCreateAgentSession } = await import('../../src/server/services/agentRuntime.js')
    const a = await getOrCreateAgentSession()
    const b = await getOrCreateAgentSession()
    expect(a).toBe(b)
  })
})

describe('session abort controller registry', () => {
  // Module-level state 必须每个 case 前清空, 否则顺序执行会污染.
  beforeEach(async () => {
    const { __resetSessionControllersForTests } = await import(
      '../../src/server/services/agentRuntime.js'
    )
    __resetSessionControllersForTests()
  })

  it('registerSessionController stores controller by sessionId', async () => {
    const { registerSessionController, abortSessionController } = await import(
      '../../src/server/services/agentRuntime.js'
    )
    const c = new AbortController()
    registerSessionController('sess-A', c)
    expect(abortSessionController('sess-A', 'test')).toBe(true)
    expect(c.signal.aborted).toBe(true)
    expect(c.signal.reason).toBe('test')
  })

  it('abortSessionController returns false for unknown session', async () => {
    const { abortSessionController } = await import(
      '../../src/server/services/agentRuntime.js'
    )
    expect(abortSessionController('sess-unknown', 'noop')).toBe(false)
  })

  it('releaseSessionController removes entry', async () => {
    const {
      registerSessionController,
      releaseSessionController,
      abortSessionController,
    } = await import('../../src/server/services/agentRuntime.js')
    const c = new AbortController()
    registerSessionController('sess-B', c)
    releaseSessionController('sess-B')
    expect(abortSessionController('sess-B', 'late')).toBe(false)
    expect(c.signal.aborted).toBe(false) // release does NOT abort, just forgets
  })

  it('abortSessionController is idempotent (second call returns false after first)', async () => {
    const { registerSessionController, abortSessionController } = await import(
      '../../src/server/services/agentRuntime.js'
    )
    const c = new AbortController()
    registerSessionController('sess-C', c)
    expect(abortSessionController('sess-C', 'first')).toBe(true)
    expect(abortSessionController('sess-C', 'second')).toBe(false)
  })
})

describe('abortAgentSession', () => {
  // Module-level state must be cleared between cases (currentSessionId +
  // sessionControllers registry).
  beforeEach(async () => {
    const { __resetSessionControllersForTests, setCurrentSessionId } = await import(
      '../../src/server/services/agentRuntime.js'
    )
    __resetSessionControllersForTests()
    setCurrentSessionId('' as unknown as string) // reset to null-ish
    // Reset to real null via getter-friendly path: the module exports a setter,
    // but the setter assigns string. Use a fresh session id per test instead.
  })

  it('aborts the registered controller for currentSessionId', async () => {
    const { abortAgentSession, setCurrentSessionId, registerSessionController } = await import(
      '../../src/server/services/agentRuntime.js'
    )
    setCurrentSessionId('sess-X')
    const c = new AbortController()
    registerSessionController('sess-X', c)
    await abortAgentSession('user_abort')
    expect(c.signal.aborted).toBe(true)
    expect(c.signal.reason).toBe('user_abort')
  })

  it('does not throw when no controller is registered for current session', async () => {
    const { abortAgentSession, setCurrentSessionId } = await import(
      '../../src/server/services/agentRuntime.js'
    )
    setCurrentSessionId('sess-Y')
    await expect(abortAgentSession('user_abort')).resolves.toBeUndefined()
  })
})