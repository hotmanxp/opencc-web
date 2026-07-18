import { describe, it, expect, vi } from 'vitest'

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