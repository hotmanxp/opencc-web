import { describe, expect, it } from 'vitest'
import { TASK_FACTORY_MAIN_AGENT_NAME, taskFactoryMainAgent } from '../../src/opencc-src/server/mainAgents-taskFactory.js'
import { superTasksCreateTool, superTasksMarkDoneTool, superTasksVerifyTool } from '../../src/opencc-src/server/taskFactoryTools.js'

describe('taskFactory mainAgent (2026-09-02)', () => {
  it('TASK_FACTORY_MAIN_AGENT_NAME === "task-factory"', () => {
    expect(TASK_FACTORY_MAIN_AGENT_NAME).toBe('task-factory')
  })

  it('taskFactoryMainAgent.name === TASK_FACTORY_MAIN_AGENT_NAME', () => {
    expect(taskFactoryMainAgent.name).toBe(TASK_FACTORY_MAIN_AGENT_NAME)
  })

  it('tools 槽追加 SuperTasksCreate / SuperTasksMarkDone / SuperTasksVerify', () => {
    const baseTools = [
      { name: 'Bash' },
      { name: 'Read' },
      { name: 'Edit' },
      { name: 'SpawnAgent' },
    ] as const
    const toolsFactory = taskFactoryMainAgent.tools
    if (typeof toolsFactory !== 'function') throw new Error('tools must be a function')
    const result = (toolsFactory as (origin: typeof baseTools) => ReadonlyArray<{ name: unknown }>)(baseTools as never)
    const names = result.map((t) => String(t.name))
    expect(names).toContain('SuperTasksCreate')
    expect(names).toContain('SuperTasksMarkDone')
    expect(names).toContain('SuperTasksVerify')
  })

  it('同源已有同名工具时去重,不再叠加', () => {
    const baseTools = [
      { name: 'SuperTasksCreate' }, // 模拟 origin 已含同名
      { name: 'SuperTasksVerify' },
    ] as const
    const toolsFactory = taskFactoryMainAgent.tools
    if (typeof toolsFactory !== 'function') throw new Error('tools must be a function')
    const result = (toolsFactory as (origin: typeof baseTools) => ReadonlyArray<{ name: unknown }>)(baseTools as never)
    const names = result.map((t) => String(t.name))
    const createCount = names.filter((n) => n === 'SuperTasksCreate').length
    const verifyCount = names.filter((n) => n === 'SuperTasksVerify').length
    expect(createCount).toBe(1)
    expect(verifyCount).toBe(1)
  })

  it('description 与 systemPrompt 是英文', async () => {
    expect(taskFactoryMainAgent.description).toContain('Task Factory supervisor')
    const prompt = taskFactoryMainAgent.systemPrompt
    const resolved = typeof prompt === 'function' ? prompt(['origin-line']) : prompt
    const arr = Array.isArray(resolved) ? resolved : [String(resolved)]
    const text = arr.join('\n')
    expect(text).toContain('SuperTasksVerify')
    expect(text).toContain('SpawnAgent')
    expect(text).toContain('verification.md')
  })

  it('三个工厂工具名字一致', () => {
    expect(superTasksCreateTool.name).toBe('SuperTasksCreate')
    expect(superTasksMarkDoneTool.name).toBe('SuperTasksMarkDone')
    expect(superTasksVerifyTool.name).toBe('SuperTasksVerify')
  })
})
