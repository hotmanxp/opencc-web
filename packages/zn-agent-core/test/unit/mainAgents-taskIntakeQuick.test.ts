import { describe, expect, it } from 'vitest'
import {
  taskIntakeQuickMainAgent,
  TASK_INTAKE_QUICK_MAIN_AGENT_NAME,
} from '../../src/opencc-src/server/mainAgents-taskIntakeQuick.js'
import { getBuiltinMainAgents } from '../../src/opencc-src/server/mainAgents.js'
import { INTAKE_QUICK_RESEARCHER_SECTION } from '../../src/opencc-src/server/mainAgents-promptSections.js'

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

describe('task-intake-quick 主 agent (2026-09-05 intake researcher lite, tfa-vy72blq6)', () => {
  it('name 与常量对齐', () => {
    expect(taskIntakeQuickMainAgent.name).toBe('task-intake-quick')
    expect(TASK_INTAKE_QUICK_MAIN_AGENT_NAME).toBe('task-intake-quick')
    expect(taskIntakeQuickMainAgent.name).toBe(TASK_INTAKE_QUICK_MAIN_AGENT_NAME)
  })

  it('description 概述 intake researcher (lite) 角色(2026-09-05)', () => {
    expect(taskIntakeQuickMainAgent.description).toContain('intake researcher')
    expect(taskIntakeQuickMainAgent.description).toContain('SuperTasksCreate')
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
    // 必须要求 SuperTasksCreate(整段契约)
    expect(text).toContain('SuperTasksCreate')
  })

  it('systemPrompt 包含 intake researcher (lite) 工作流关键串(RESEARCHER section)', async () => {
    const slot = taskIntakeQuickMainAgent.systemPrompt
    if (typeof slot !== 'function') throw new Error('systemPrompt must be a function')
    const arr = await slot([])
    const text = arr.join('\n')
    // intake researcher (lite) 角色定位
    expect(text).toContain('intake researcher')
    // 工作流步骤
    expect(text).toMatch(/Read the user.*description/i)
    expect(text).toContain('codegraph_explore')
    // 硬约束:最多 3 个澄清问题
    expect(text).toMatch(/at most 3.*clarifying questions|Maximum 3 clarifying/i)
    // DESIGN_READY marker 契约:agent 出方案后单独一行,前端据此 enable 确认按钮
    expect(text).toContain('## DESIGN_READY')
    // 禁调 SkillTool
    expect(text).toContain('SkillTool')
    // attachments 提取契约:从表单 attachments 段抽 paths,传给 SuperTasksCreate
    expect(text).toContain('attachments')
    expect(text).toMatch(/attachments \(absolute paths.*Read these/i)
  })

  it('systemPrompt 顺序:RESEARCHER section 先出现(角色 + 工作流),quick-specific prompt 后出现(契约字段 + mode: "quick")', async () => {
    const slot = taskIntakeQuickMainAgent.systemPrompt
    if (typeof slot !== 'function') throw new Error('systemPrompt must be a function')
    const arr = await slot([])
    const text = arr.join('\n')
    // 「intake researcher」字符串位置先于「mode: \"quick\"」位置
    const researcherIdx = text.indexOf('intake researcher')
    const modeIdx = text.search(/mode:\s*['"]quick['"]/)
    expect(researcherIdx).toBeGreaterThan(-1)
    expect(modeIdx).toBeGreaterThan(-1)
    expect(researcherIdx).toBeLessThan(modeIdx)
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

describe('INTAKE_QUICK_RESEARCHER_SECTION (tfa-vy72blq6 2026-09-05)', () => {
  // RESEARCHER section 独立单测:确保后续维护 promptSections.ts 时,角色定位 +
  // 工作流 + 硬约束不会回流到 brainstorming / planning doc / SkillTool 调用。
  it('section 是 string[] 且非空', () => {
    expect(Array.isArray(INTAKE_QUICK_RESEARCHER_SECTION)).toBe(true)
    expect(INTAKE_QUICK_RESEARCHER_SECTION.length).toBeGreaterThan(0)
    for (const line of INTAKE_QUICK_RESEARCHER_SECTION) {
      expect(typeof line).toBe('string')
    }
  })

  it('包含 intake researcher 角色定位与工作流关键步骤', () => {
    const text = INTAKE_QUICK_RESEARCHER_SECTION.join('\n')
    expect(text).toContain('intake researcher')
    expect(text).toContain('QuickCreateModal')
    expect(text).toMatch(/Read the user.*description/i)
    expect(text).toContain('codegraph_explore')
    expect(text).toContain('Grep')
    expect(text).toContain('Read')
  })

  it('硬约束:最多 3 个澄清问题 / 禁调 SkillTool / DESIGN_READY marker / cancel 不调 create', () => {
    const text = INTAKE_QUICK_RESEARCHER_SECTION.join('\n')
    expect(text).toMatch(/at most 3.*clarifying questions|Maximum 3 clarifying/i)
    expect(text).toContain('SkillTool')
    expect(text).toContain('## DESIGN_READY')
    expect(text).toMatch(/cancel|算了|不要了/i)
    // user confirm 后才调 SuperTasksCreate,不能提前
    expect(text).toMatch(/Do NOT call SuperTasksCreate before the user confirms/i)
  })

  it('强禁词:不出现 brainstorming / plan.md / brainstorm.md 字样', () => {
    const text = INTAKE_QUICK_RESEARCHER_SECTION.join('\n')
    expect(text).not.toMatch(/brainstorming/i)
    expect(text).not.toMatch(/plan\.md/)
    expect(text).not.toMatch(/brainstorm\.md/)
  })

  it('附件契约:从表单 attachments 段抽 paths 传给 SuperTasksCreate', () => {
    const text = INTAKE_QUICK_RESEARCHER_SECTION.join('\n')
    expect(text).toMatch(/attachments \(absolute paths.*Read these/i)
    expect(text).toContain('attachments')
    expect(text).toMatch(/Do NOT inline.*paths.*into description/i)
  })
})
