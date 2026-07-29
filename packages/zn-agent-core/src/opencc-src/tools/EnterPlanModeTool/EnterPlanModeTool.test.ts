import { describe, expect, test } from 'bun:test'
import { EnterPlanModeTool } from './EnterPlanModeTool.ts'

describe('EnterPlanModeTool', () => {
  test('description matches upstream 2.1.177 hybrid text (preserved permission framing + user sign-off guidance)', async () => {
    expect(
      await EnterPlanModeTool.description(
        {},
        {
          isNonInteractiveSession: false,
          toolPermissionContext: {} as never,
          tools: [] as never,
        },
      ),
    ).toBe(
      'Requests permission to enter plan mode for non-trivial implementation tasks. Plan mode is the recommended first step for tasks that touch multiple files or require design decisions — getting user sign-off on the approach before writing code prevents wasted effort. Use ExitPlanMode when done.',
    )
  })
})
