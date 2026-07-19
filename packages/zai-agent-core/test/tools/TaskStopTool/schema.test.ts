import { describe, expect, test } from 'vitest'
import {
  TaskStopInputSchema,
  type TaskStopInput,
} from '../../../src/tools/TaskStopTool/schema.js'
import {
  TaskStopTool,
  TASK_STOP_TOOL_NAME,
  KILL_SHELL_TOOL_NAME,
} from '../../../src/tools/TaskStopTool/TaskStopTool.js'
import { wrapAsOpenccTool } from '../../../src/tools/legacyAdapter.js'
import { toolMatchesName } from '../../../src/opencc-internals/Tool.js'

describe('TaskStopTool schema — legacy parameter compat (KillShell)', () => {
  test('canonical task_id path', () => {
    const r = TaskStopInputSchema.parse({ task_id: 't1' }) as TaskStopInput
    expect(r.task_id).toBe('t1')
    expect(r.reason).toBeUndefined()
  })

  test('alias shell_id (KillShell) falls back to task_id', () => {
    const r = TaskStopInputSchema.parse({ shell_id: 's1' }) as TaskStopInput
    expect(r.task_id).toBe('s1')
  })

  test('task_id wins over shell_id (canonical has priority)', () => {
    const r = TaskStopInputSchema.parse({
      task_id: 'canon',
      shell_id: 'legacy',
    }) as TaskStopInput
    expect(r.task_id).toBe('canon')
  })

  test('reason is preserved', () => {
    const r = TaskStopInputSchema.parse({
      task_id: 't1',
      reason: 'cancelled by user',
    }) as TaskStopInput
    expect(r.reason).toBe('cancelled by user')
  })

  test('empty input — task_id becomes empty string (caller treats as not found)', () => {
    const r = TaskStopInputSchema.parse({}) as TaskStopInput
    expect(r.task_id).toBe('')
  })
})

describe('TaskStopTool — aliases registration', () => {
  test('exposes KillShell alias', () => {
    expect(TaskStopTool.name).toBe(TASK_STOP_TOOL_NAME)
    expect(TaskStopTool.aliases).toEqual(
      expect.arrayContaining([KILL_SHELL_TOOL_NAME]),
    )
  })

  test('wrapAsOpenccTool forwards aliases', () => {
    const wrapped = wrapAsOpenccTool(TaskStopTool) as unknown as {
      name: string
      aliases?: string[]
    }
    expect(wrapped.name).toBe(TASK_STOP_TOOL_NAME)
    expect(wrapped.aliases).toEqual(
      expect.arrayContaining([KILL_SHELL_TOOL_NAME]),
    )
  })

  test('findToolByName (opencc toolMatchesName) hits both primary and alias', () => {
    const wrapped = wrapAsOpenccTool(TaskStopTool) as unknown as {
      name: string
      aliases?: string[]
    }
    expect(toolMatchesName(wrapped, TASK_STOP_TOOL_NAME)).toBe(true)
    expect(toolMatchesName(wrapped, KILL_SHELL_TOOL_NAME)).toBe(true)
    expect(toolMatchesName(wrapped, 'TaskStart')).toBe(false)
  })
})