import { describe, expect, it } from 'vitest'
import { getBuiltinMainAgents } from '../../src/opencc-src/server/mainAgents.js'
import { OFFICE_MAIN_AGENT_NAME } from '../../src/opencc-src/server/mainAgents-office.js'

/** 覆盖各家族的假工具池:办公必需 / 界面向 / MCP。 */
function fakeTools(): { name: string }[] {
  return [
    // 办公白名单 — 保留
    { name: 'Read' },
    { name: 'Edit' },
    { name: 'Write' },
    { name: 'Grep' },
    { name: 'Glob' },
    { name: 'Bash' },
    { name: 'WebSearch' },
    { name: 'Skill' },
    { name: 'AskUserQuestion' },
    { name: 'TaskCreate' },
    { name: 'TaskGet' },
    { name: 'TaskUpdate' },
    { name: 'TaskList' },
    // 非白名单内置 — 剔除
    { name: 'WebFetch' },
    { name: 'DisplayFiles' },
    { name: 'Workflow' },
    { name: 'EnterWorktree' },
    { name: 'LSP' },
    // MCP 工具 — 全放行(与 weixin-bot 同约定)
    { name: 'mcp__cua-driver__screenshot' },
    { name: 'mcp__cua-driver__click' },
    { name: 'mcp__context7__resolve-library-id' },
  ]
}

function officeTools(): string[] {
  const office = getBuiltinMainAgents().find((a) => a.name === OFFICE_MAIN_AGENT_NAME)!
  return (office.tools!(fakeTools() as never) as { name: string }[]).map((t) => t.name)
}

describe('office main agent tools 槽', () => {
  it('注册进内置列表,固定 name=office', () => {
    const office = getBuiltinMainAgents().find((a) => a.name === OFFICE_MAIN_AGENT_NAME)
    expect(office).toBeTruthy()
    expect(office!.tools).toBeTypeOf('function')
  })

  it('放行所有 mcp__* 工具(Computer Use 等 MCP server 在办公助手里可见)', () => {
    const names = officeTools()
    expect(names).toContain('mcp__cua-driver__screenshot')
    expect(names).toContain('mcp__cua-driver__click')
    expect(names).toContain('mcp__context7__resolve-library-id')
  })

  it('办公白名单保留,非白名单内置仍被剔除', () => {
    const names = officeTools()
    expect(names).toContain('Read')
    expect(names).toContain('WebSearch')
    expect(names).toContain('TaskCreate')
    const dropped = ['WebFetch', 'DisplayFiles', 'Workflow', 'EnterWorktree', 'LSP']
    for (const n of dropped) expect(names).not.toContain(n)
  })
})
