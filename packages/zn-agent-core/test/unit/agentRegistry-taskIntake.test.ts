/**
 * zai patch (2026-09-02, task-factory 新建任务改造): 内置需求讨论 agent
 * `task-intake` 注册验证。
 *   1. loadBuiltinAgents 后 name='task-intake' 已注册且有 description
 *   2. tools 槽含 SuperTasksCreate、**不含** SuperTasksMarkDone(不验收)
 *   3. tools 槽去重(origin 已有同名时不重复追加)且保留默认工具池
 */
import { describe, expect, it } from 'vitest'
import {
  resetAgentRegistryForTests,
  getAgentRegistry,
} from '../../src/opencc-src/server/agentRegistry.js'

describe('task-intake builtin agent', () => {
  it('注册可见,tools 槽含 SuperTasksCreate 且不含 SuperTasksMarkDone', async () => {
    resetAgentRegistryForTests()
    const reg = getAgentRegistry()
    reg.loadBuiltinAgents()
    reg.registryAgent('sess-1', 'task-intake')
    const tools = await reg.slot([], 'tools', 'sess-1')
    const names = tools.map((t) => t.name)
    expect(names).toContain('SuperTasksCreate')
    expect(names).not.toContain('SuperTasksMarkDone')
    expect(reg.resolveAgent('task-intake')?.description).toBeTruthy()
  })

  it('tools 槽保留默认工具池且不重复追加同名工具', async () => {
    resetAgentRegistryForTests()
    const reg = getAgentRegistry()
    reg.loadBuiltinAgents()
    reg.registryAgent('sess-2', 'task-intake')
    const tools = await reg.slot(
      [
        { name: 'Skill' } as never,
        { name: 'SuperTasksCreate' } as never,
      ],
      'tools',
      'sess-2',
    )
    expect(tools.some((t) => t.name === 'Skill')).toBe(true)
    expect(tools.filter((t) => t.name === 'SuperTasksCreate')).toHaveLength(1)
  })
})
