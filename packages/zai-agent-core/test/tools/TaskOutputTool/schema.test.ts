import { describe, expect, test } from 'vitest'
import {
  TaskOutputInputSchema,
  type TaskOutputInput,
} from '../../../src/tools/TaskOutputTool/schema.js'
import {
  TaskOutputTool,
  TASK_OUTPUT_TOOL_NAME,
  AGENT_OUTPUT_TOOL_NAME,
  BASH_OUTPUT_TOOL_NAME,
} from '../../../src/tools/TaskOutputTool/TaskOutputTool.js'
import { wrapAsOpenccTool } from '../../../src/tools/legacyAdapter.js'
import { toolMatchesName } from '../../../src/opencc-internals/Tool.js'

describe('TaskOutputTool schema — legacy parameter compat', () => {
  test('canonical task_id path (no aliases)', () => {
    const r = TaskOutputInputSchema.parse({ task_id: 't1' }) as TaskOutputInput
    expect(r.task_id).toBe('t1')
    expect(r.block).toBe(true)
    expect(r.timeout).toBe(600000)
    expect(r.tailLines).toBe(200)
  })

  test('alias bash_id (BashOutputTool) falls back to task_id', () => {
    const r = TaskOutputInputSchema.parse({ bash_id: 'b1' }) as TaskOutputInput
    expect(r.task_id).toBe('b1')
  })

  test('alias agentId (AgentOutputTool) falls back to task_id', () => {
    const r = TaskOutputInputSchema.parse({ agentId: 'a1' }) as TaskOutputInput
    expect(r.task_id).toBe('a1')
  })

  test('task_id wins over bash_id / agentId (canonical has priority)', () => {
    const r = TaskOutputInputSchema.parse({
      task_id: 'canon',
      bash_id: 'b',
      agentId: 'a',
    }) as TaskOutputInput
    expect(r.task_id).toBe('canon')
  })

  test('wait_up_to (seconds) → timeout (ms) conversion', () => {
    const r = TaskOutputInputSchema.parse({
      task_id: 't1',
      wait_up_to: 5,
    }) as TaskOutputInput
    expect(r.timeout).toBe(5000)
  })

  test('explicit timeout wins over wait_up_to', () => {
    const r = TaskOutputInputSchema.parse({
      task_id: 't1',
      timeout: 1234,
      wait_up_to: 5,
    }) as TaskOutputInput
    expect(r.timeout).toBe(1234)
  })

  test('block=false is preserved through transform', () => {
    const r = TaskOutputInputSchema.parse({
      task_id: 't1',
      block: false,
    }) as TaskOutputInput
    expect(r.block).toBe(false)
  })

  test('empty input — task_id becomes empty string (caller treats as not_ready)', () => {
    const r = TaskOutputInputSchema.parse({}) as TaskOutputInput
    expect(r.task_id).toBe('')
  })

  test('rejects timeout > 600000ms (opencc-aligned ceiling)', () => {
    expect(() => TaskOutputInputSchema.parse({ task_id: 't1', timeout: 600001 })).toThrow()
  })
})

describe('TaskOutputTool — aliases registration', () => {
  test('exposes BashOutput + AgentOutput aliases', () => {
    expect(TaskOutputTool.name).toBe(TASK_OUTPUT_TOOL_NAME)
    expect(TaskOutputTool.aliases).toEqual(
      expect.arrayContaining([BASH_OUTPUT_TOOL_NAME, AGENT_OUTPUT_TOOL_NAME]),
    )
  })

  test('wrapAsOpenccTool forwards aliases', () => {
    const wrapped = wrapAsOpenccTool(TaskOutputTool) as unknown as {
      name: string
      aliases?: string[]
    }
    expect(wrapped.name).toBe(TASK_OUTPUT_TOOL_NAME)
    expect(wrapped.aliases).toEqual(
      expect.arrayContaining([BASH_OUTPUT_TOOL_NAME, AGENT_OUTPUT_TOOL_NAME]),
    )
  })

  test('findToolByName (opencc toolMatchesName) hits both primary and aliases', () => {
    const wrapped = wrapAsOpenccTool(TaskOutputTool) as unknown as {
      name: string
      aliases?: string[]
    }
    expect(toolMatchesName(wrapped, TASK_OUTPUT_TOOL_NAME)).toBe(true)
    expect(toolMatchesName(wrapped, BASH_OUTPUT_TOOL_NAME)).toBe(true)
    expect(toolMatchesName(wrapped, AGENT_OUTPUT_TOOL_NAME)).toBe(true)
    expect(toolMatchesName(wrapped, 'UnknownTool')).toBe(false)
  })
})