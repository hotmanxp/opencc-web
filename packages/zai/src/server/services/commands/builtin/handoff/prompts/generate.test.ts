import { describe, it, expect } from 'vitest'
import { buildGeneratePrompt } from './generate.js'

const baseParams = {
  cwd: '/Users/x/project',
  root: '/Users/x/project/.agent_working_dir/handoff',
  date: '2026-08-16',
}

describe('buildGeneratePrompt', () => {
  it('包含所有 vendor 章节标识', () => {
    const out = buildGeneratePrompt({ ...baseParams, taskListText: null })
    for (const heading of [
      '### Task title',
      '### Original Request',
      '### Goal',
      '### Artifacts',
      '### Key Findings',
      '### Pitfalls',
      '### Current TaskList',
      '### Next Steps',
      '### Skills Used',
    ]) {
      expect(out, `应包含 ${heading}`).toContain(heading)
    }
  })

  it('嵌入 cwd / root / date', () => {
    const out = buildGeneratePrompt({ ...baseParams, taskListText: null })
    expect(out).toContain(baseParams.cwd)
    expect(out).toContain(baseParams.root)
    expect(out).toContain(baseParams.date)
  })

  it('taskListText 非 null 时嵌入实际内容', () => {
    const out = buildGeneratePrompt({
      ...baseParams,
      taskListText: '- [x] 写 handoff 命令',
    })
    expect(out).toContain('- [x] 写 handoff 命令')
  })

  it('taskListText 为 null 时嵌入未提供占位', () => {
    const out = buildGeneratePrompt({ ...baseParams, taskListText: null })
    expect(out).toContain('(未提供 — 请从对话上文推断当前任务列表)')
  })

  it('包含写文件指令和回执文案', () => {
    const out = buildGeneratePrompt({ ...baseParams, taskListText: null })
    expect(out).toContain('Write')
    expect(out).toContain('✅ Handoff document written:')
  })
})
