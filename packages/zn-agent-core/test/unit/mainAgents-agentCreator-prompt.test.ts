import { describe, expect, it } from 'vitest'
import { agentCreatorMainAgent } from '../../src/opencc-src/server/mainAgents-agentCreator.js'

describe('agent-creator systemPrompt: tools 槽 MCP 放行规范 (2026-09-22)', () => {
  it('allowlist 指引要求同时 OR 放行 mcp__* 前缀', async () => {
    const slot = agentCreatorMainAgent.systemPrompt
    if (typeof slot !== 'function') throw new Error('systemPrompt must be a function')
    const joined = (await slot([])).join('\n')
    // 关键片段:告诉生成的外置 agent 必须放行 MCP 工具
    expect(joined).toContain("t.name.startsWith('mcp__')")
    expect(joined).toMatch(/Computer Use is on but the tool is missing/i)
  })
})
