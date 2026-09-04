import { describe, expect, it } from 'vitest'
import { TASK_FACTORY_MAIN_AGENT_NAME, taskFactoryMainAgent } from '../../src/opencc-src/server/mainAgents-taskFactory.js'
import {
  superTasksCreateTool, superTasksListTool, superTasksGetTool, superTasksMoveTool, superTasksResetTool, superTasksPauseTool,
} from '../../src/opencc-src/server/taskFactoryTools.js'

describe('taskFactory mainAgent (2026-09-02 supervisor state-transition tools)', () => {
  it('TASK_FACTORY_MAIN_AGENT_NAME === "task-factory"', () => {
    expect(TASK_FACTORY_MAIN_AGENT_NAME).toBe('task-factory')
  })

  it('taskFactoryMainAgent.name === TASK_FACTORY_MAIN_AGENT_NAME', () => {
    expect(taskFactoryMainAgent.name).toBe(TASK_FACTORY_MAIN_AGENT_NAME)
  })

  it('tools 槽追加 6 个 SuperTasks* 工具 + CreateWorktree', () => {
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
    for (const n of ['SuperTasksCreate', 'SuperTasksList', 'SuperTasksGet', 'SuperTasksMove', 'SuperTasksReset', 'SuperTasksPause', 'CreateWorktree']) {
      expect(names).toContain(n)
    }
  })

  it('不再包含已删除的 SuperTasksVerify / SuperTasksMarkDone', () => {
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
    expect(names).not.toContain('SuperTasksVerify')
    expect(names).not.toContain('SuperTasksMarkDone')
  })

  it('同源已有同名工具时去重,不再叠加', () => {
    const baseTools = [
      { name: 'SuperTasksCreate' }, // 模拟 origin 已含同名
      { name: 'SuperTasksList' },
      { name: 'SuperTasksGet' },
      { name: 'SuperTasksMove' },
      { name: 'SuperTasksReset' },
      { name: 'SuperTasksPause' },
      { name: 'CreateWorktree' },
    ] as const
    const toolsFactory = taskFactoryMainAgent.tools
    if (typeof toolsFactory !== 'function') throw new Error('tools must be a function')
    const result = (toolsFactory as (origin: typeof baseTools) => ReadonlyArray<{ name: unknown }>)(baseTools as never)
    const names = result.map((t) => String(t.name))
    for (const n of ['SuperTasksCreate', 'SuperTasksList', 'SuperTasksGet', 'SuperTasksMove', 'SuperTasksReset', 'SuperTasksPause', 'CreateWorktree']) {
      expect(names.filter((x) => x === n)).toHaveLength(1)
    }
  })

  it('description 为中文 UI 文案,systemPrompt 是英文', async () => {
    // description 只用于 settings 下拉展示(用户可见 UI 文案),按规范用中文;
    // systemPrompt 发给模型,保持英文。
    expect(taskFactoryMainAgent.description).toContain('任务调度官')
    const prompt = taskFactoryMainAgent.systemPrompt
    const resolved = typeof prompt === 'function' ? prompt(['origin-line']) : prompt
    const arr = Array.isArray(resolved) ? resolved : [String(resolved)]
    const text = arr.join('\n')
    // 调度官 prompt 必须出现新工具名 + 关键流程词
    expect(text).toContain('SuperTasksMove')
    expect(text).toContain('SuperTasksReset')
    expect(text).toContain('SuperTasksPause')
    expect(text).toContain('SpawnAgent')
    expect(text).toContain('verification.md')
    // 2026-09-02:SuperTasksGet 替代裸读 task.yaml
    expect(text).toContain('SuperTasksGet')
    expect(text).toContain('SuperTasksList')
    expect(text).not.toContain('Read <task_dir>/task.yaml')
    expect(text).not.toContain('Read task.yaml')
    // 2026-09-03:工作目录冲突 + 独立 feature 分支 + commit-id 回写纪律
    expect(text).toContain('Workspace-conflict discipline')
    expect(text).toContain('CreateWorktree')
    expect(text).toContain('Independent feature branch REQUIRED')
    expect(text).toContain('commit: <full-sha>')
    // 2026-09-03(合回主干改 PR + 集成验证):不 merge base,走 integration-main + PR
    expect(text).toContain('Integration verification lane')
    expect(text).toContain('integration-main')
    expect(text).toContain('awaits their PR')
    expect(text).toContain('reset --hard')
    expect(text).not.toContain('git -C <repoPath> merge task-')
  })

  it('六个工厂工具名字一致', () => {
    expect(superTasksCreateTool.name).toBe('SuperTasksCreate')
    expect(superTasksListTool.name).toBe('SuperTasksList')
    expect(superTasksGetTool.name).toBe('SuperTasksGet')
    expect(superTasksMoveTool.name).toBe('SuperTasksMove')
    expect(superTasksResetTool.name).toBe('SuperTasksReset')
    expect(superTasksPauseTool.name).toBe('SuperTasksPause')
  })
})
