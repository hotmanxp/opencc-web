import { describe, expect, it } from 'vitest'
import { taskIntakeMainAgent } from '../../src/opencc-src/server/mainAgents-taskIntake.js'

function fakePool() {
  return [
    { name: 'Read' },
    { name: 'Edit' },
    { name: 'Write' },
    { name: 'Glob' },
    { name: 'Grep' },
    { name: 'Bash' },
    { name: 'Skill' },
    { name: 'AskUserQuestion' },
    { name: 'TaskCreate' },
    { name: 'TaskGet' },
    { name: 'TaskUpdate' },
    { name: 'TaskList' },
    { name: 'NotebookEdit' },
    { name: 'SpawnAgent' },
    { name: 'TodoWrite' },
    { name: 'WebFetch' },
    { name: 'mcp__codegraph__codegraph_explore' },
    { name: 'mcp__chrome-devtools-mcp__navigate_page' },
  ] as const
}

describe('task-intake tools slot (2026-09-03 whitelist)', () => {
  it('keeps allowlist + all mcp__* tools, drops coding/delegation tools', () => {
    const slot = taskIntakeMainAgent.tools
    if (typeof slot !== 'function') throw new Error('tools must be a function')
    const names = slot(fakePool() as never).map((t) => String(t.name))
    for (const kept of ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Skill', 'AskUserQuestion', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']) {
      expect(names).toContain(kept)
    }
    // MCP 工具全保留 —— 与 systemPrompt 保留 # CodeGraph 段配套
    expect(names).toContain('mcp__codegraph__codegraph_explore')
    expect(names).toContain('mcp__chrome-devtools-mcp__navigate_page')
    // 编码/派发/管理类工具剔除
    for (const gone of ['NotebookEdit', 'SpawnAgent', 'TodoWrite', 'WebFetch']) {
      expect(names).not.toContain(gone)
    }
  })

  it('appends SuperTasksCreate exactly once (also when origin lacks it twice-applied)', () => {
    const slot = taskIntakeMainAgent.tools
    if (typeof slot !== 'function') throw new Error('tools must be a function')
    const once = slot(fakePool() as never).map((t) => String(t.name))
    expect(once.filter((n) => n === 'SuperTasksCreate')).toHaveLength(1)
    // 二次应用(模拟 origin 已含注入结果)不叠加
    const twice = slot(once.map((name) => ({ name })) as never).map((t) => String(t.name))
    expect(twice.filter((n) => n === 'SuperTasksCreate')).toHaveLength(1)
  })
})
