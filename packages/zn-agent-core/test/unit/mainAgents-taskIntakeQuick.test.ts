import { describe, expect, it } from 'vitest'
import {
  taskIntakeQuickMainAgent,
  TASK_INTAKE_QUICK_MAIN_AGENT_NAME,
} from '../../src/opencc-src/server/mainAgents-taskIntakeQuick.js'
import { getBuiltinMainAgents } from '../../src/opencc-src/server/mainAgents.js'

function fakePool() {
  return [
    { name: 'Read' },
    { name: 'Write' },
    { name: 'Edit' },
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

describe('task-intake-quick 主 agent (2026-09-04 quick-intake)', () => {
  it('name 与常量对齐', () => {
    expect(taskIntakeQuickMainAgent.name).toBe('task-intake-quick')
    expect(TASK_INTAKE_QUICK_MAIN_AGENT_NAME).toBe('task-intake-quick')
    expect(taskIntakeQuickMainAgent.name).toBe(TASK_INTAKE_QUICK_MAIN_AGENT_NAME)
  })

  it('description 概述快速创建语义', () => {
    expect(taskIntakeQuickMainAgent.description).toContain('快速创建')
  })

  it('systemPrompt 关键串:无 brainstorming / plan.md / brainstorm.md 字样,带 mode: "quick"', async () => {
    const slot = taskIntakeQuickMainAgent.systemPrompt
    if (typeof slot !== 'function') throw new Error('systemPrompt must be a function')
    const arr = await slot([])
    const text = arr.join('\n')
    // 严禁包含 brainstorming / plan.md / brainstorm.md 字面字符串(强制约束)
    expect(text).not.toMatch(/brainstorming/i)
    expect(text).not.toMatch(/plan\.md/)
    expect(text).not.toMatch(/brainstorm\.md/)
    // 必须包含 mode: 'quick' 提示
    expect(text).toMatch(/mode:\s*['"]quick['"]/)
    // 必须要求单步 SuperTasksCreate 是 happy path
    expect(text).toContain('SuperTasksCreate')
  })

  it('tools 白名单:只允许 Read/Write/Grep/Glob/Bash/AskUserQuestion/SuperTasksCreate + mcp__*,过滤掉 Skill/NotebookEdit/SpawnAgent', () => {
    const slot = taskIntakeQuickMainAgent.tools
    if (typeof slot !== 'function') throw new Error('tools must be a function')
    const names = slot(fakePool() as never).map((t) => String(t.name))
    // 必须包含白名单 + MCP 工具
    for (const kept of ['Read', 'Write', 'Grep', 'Glob', 'Bash', 'AskUserQuestion']) {
      expect(names).toContain(kept)
    }
    expect(names).toContain('mcp__codegraph__codegraph_explore')
    expect(names).toContain('mcp__chrome-devtools-mcp__navigate_page')
    // 不应包含 brainstorming 相关(任务系列、Skill、NotebookEdit、SpawnAgent、TodoWrite、Edit、Task*)
    for (const gone of ['Skill', 'NotebookEdit', 'SpawnAgent', 'TodoWrite', 'WebFetch', 'Edit',
      'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']) {
      expect(names).not.toContain(gone)
    }
    // SuperTasksCreate 必须存在(自动 append)
    expect(names).toContain('SuperTasksCreate')
  })

  it('tools 槽幂等:二次应用不叠加 SuperTasksCreate', () => {
    const slot = taskIntakeQuickMainAgent.tools
    if (typeof slot !== 'function') throw new Error('tools must be a function')
    const once = slot(fakePool() as never).map((t) => String(t.name))
    expect(once.filter((n) => n === 'SuperTasksCreate')).toHaveLength(1)
    const twice = slot(once.map((name) => ({ name })) as never).map((t) => String(t.name))
    expect(twice.filter((n) => n === 'SuperTasksCreate')).toHaveLength(1)
  })

  it('getBuiltinMainAgents() 包含 task-intake-quick', () => {
    const agents = getBuiltinMainAgents()
    const found = agents.find((a) => a.name === 'task-intake-quick')
    expect(found).toBeDefined()
    expect(found?.name).toBe('task-intake-quick')
  })

  it('getBuiltinMainAgents() 同时保留 task-intake(完整 intake 流程不被破坏)', () => {
    const agents = getBuiltinMainAgents()
    expect(agents.find((a) => a.name === 'task-intake')).toBeDefined()
    expect(agents.find((a) => a.name === 'task-intake-quick')).toBeDefined()
    // 数量增加 1(从 5 个内置变 6 个)
    expect(agents.length).toBeGreaterThanOrEqual(6)
  })
})
