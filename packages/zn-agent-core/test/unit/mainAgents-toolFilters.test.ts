import { describe, expect, it } from 'vitest'
import { filterBannedTools } from '../../src/opencc-src/server/mainAgents-toolFilters.js'
import { getBuiltinMainAgents } from '../../src/opencc-src/server/mainAgents.js'
import { taskFactoryMainAgent } from '../../src/opencc-src/server/mainAgents-taskFactory.js'
import { agentCreatorMainAgent } from '../../src/opencc-src/server/mainAgents-agentCreator.js'

function pool(names: string[]) {
  return names.map((name) => ({ name })) as never
}
const NET_POOL = ['Read', 'Bash', 'WebFetch', 'WebSearch', 'SpawnAgent']

describe('WebFetch banned on restricted intranet (2026-09-03)', () => {
  it('filterBannedTools removes WebFetch only', () => {
    const names = filterBannedTools(pool(NET_POOL)).map((t) => String(t.name))
    expect(names).toEqual(['Read', 'Bash', 'WebSearch', 'SpawnAgent'])
  })

  it('default tools slot strips WebFetch but keeps DisplayFiles', () => {
    const def = getBuiltinMainAgents().find((a) => a.name === 'default')!
    const names = def.tools!(pool(NET_POOL)).map((t) => String(t.name))
    expect(names).not.toContain('WebFetch')
    expect(names).toContain('DisplayFiles')
    expect(names).toContain('WebSearch')
  })

  it('task-factory tools slot: strips WebFetch + Task v2 + plan-mode/worktree/LSP, adds CreateWorktree', () => {
    const names = taskFactoryMainAgent.tools!(
      pool([
        ...NET_POOL,
        'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
        'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'LSP',
      ]),
    ).map((t) => String(t.name))
    expect(names).not.toContain('WebFetch')
    // 主管职责无关的会话级工具全部剔除
    for (const gone of [
      'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
      'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'LSP',
    ]) {
      expect(names).not.toContain(gone)
    }
    expect(names).toContain('SpawnAgent')
    expect(names).toContain('SuperTasksMove')
    expect(names).toContain('CreateWorktree')
  })

  it('agent-creator allowlist has no WebFetch, has WebSearch', () => {
    const names = agentCreatorMainAgent.tools!(pool(NET_POOL)).map((t) => String(t.name))
    expect(names).not.toContain('WebFetch')
    expect(names).toContain('WebSearch')
  })
})
