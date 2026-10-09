import { describe, expect, it } from 'vitest'
import { TaskCreateTool } from '../../../src/compat/tools/tasks/TaskCreateTool.js'
import { TaskUpdateTool } from '../../../src/compat/tools/tasks/TaskUpdateTool.js'
import { TaskListTool } from '../../../src/compat/tools/tasks/TaskListTool.js'

// This file used to assert `buildDefaultTools()` — the zai compat tool
// registry — contained TaskCreate/Get/Update/List. That registry was deleted
// when the tool pool moved to vendor's `getTools()` (opencc-src/tools.ts:237,
// gated on isTodoV2Enabled()), and neither it nor the tool objects are part
// of the published bundle surface, so there is no stable public entry point
// to assert "the pool contains X" against.
//
// What zai actually owns is the task *executors* below: they back the
// vendor task tools, persist via taskListStore, and emit on stateChangeBus.
// Assert that surface. End-to-end behavior (persist + event emission) is
// covered by test/integration/taskToolsIntegration.test.ts; the vendor tool
// wrappers carry their own upstream coverage.
describe('compat task tool executors', () => {
  it('exposes create / update / list executors', () => {
    for (const tool of [TaskCreateTool, TaskUpdateTool, TaskListTool]) {
      expect(typeof tool.call).toBe('function')
      expect(tool.inputSchema).toBeDefined()
    }
  })

  it('TaskCreate accepts a subject in its input schema', () => {
    const shape = TaskCreateTool.inputSchema as unknown as {
      shape?: Record<string, unknown>
    }
    expect(Object.keys(shape?.shape ?? {})).toContain('subject')
  })

  it('TaskList takes no required input', () => {
    const shape = TaskListTool.inputSchema as unknown as {
      shape?: Record<string, unknown>
    }
    expect(shape?.shape ?? {}).toEqual({})
  })
})