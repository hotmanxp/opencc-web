import { describe, expect, test } from 'bun:test'
import { DESCRIPTION } from './prompt.js'
import { TaskCreateTool } from './TaskCreateTool.js'

describe('TaskCreate description sync (upstream 2.1.177)', () => {
  test('description matches HYBRID final string (preserves metadata mention + adds UP track-progress steer)', () => {
    expect(DESCRIPTION).toBe(
      'Create a new task in the task list. Use this to track progress, organize complex multi-step work, and demonstrate thoroughness. Tasks support metadata for tracking additional context.',
    )
  })

  test('description contains "track progress" (UP steer)', () => {
    expect(DESCRIPTION).toContain('track progress')
  })

  test('description mentions metadata (OC-specific field)', () => {
    expect(DESCRIPTION).toContain('metadata')
  })

  test('runtime description() returns the new text (catches inline-literal drift)', async () => {
    const desc = await (
      TaskCreateTool.description as unknown as () => Promise<string>
    )()
    expect(desc).toBe(
      'Create a new task in the task list. Use this to track progress, organize complex multi-step work, and demonstrate thoroughness. Tasks support metadata for tracking additional context.',
    )
  })
})
