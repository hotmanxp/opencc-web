/**
 * zai patch (2026-09-01, task-factory): 内置任务主管 agent `task-factory`
 * 注册验证。
 *   1. `loadBuiltinAgents()` 后 agent name='task-factory' 已注册且有 description
 *   2. tools 槽含 SuperTasksCreate / SuperTasksMarkDone 两个工具
 *   3. tools 槽保留默认工具池(SpawnAgent 可用)
 */
import { describe, expect, it } from 'vitest'
import {
  resetAgentRegistryForTests,
  getAgentRegistry,
} from '../../src/opencc-src/server/agentRegistry.js'

describe('task-factory builtin agent', () => {
  it('loadBuiltinAgents 注册 task-factory,tools 槽含两个 SuperTasks 工具', async () => {
    resetAgentRegistryForTests()
    const reg = getAgentRegistry()
    reg.loadBuiltinAgents()
    reg.registryAgent('sess-1', 'task-factory')
    const tools = await reg.slot([], 'tools', 'sess-1')
    const names = tools.map((t) => t.name)
    expect(names).toContain('SuperTasksCreate')
    expect(names).toContain('SuperTasksMarkDone')
    expect(reg.resolveAgent('task-factory')?.description).toBeTruthy()
  })

  it('tools 槽保留默认工具池(SpawnAgent 可用)', async () => {
    resetAgentRegistryForTests()
    const reg = getAgentRegistry()
    reg.loadBuiltinAgents()
    reg.registryAgent('sess-2', 'task-factory')
    const tools = await reg.slot(
      [{ name: 'SpawnAgent' } as never],
      'tools',
      'sess-2',
    )
    expect(tools.some((t) => t.name === 'SpawnAgent')).toBe(true)
  })
})
