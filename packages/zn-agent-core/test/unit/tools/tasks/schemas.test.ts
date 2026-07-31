import { describe, expect, it } from 'vitest'
import {
  TaskCreateInput,
  TaskGetInput,
  TaskListInput,
  TaskUpdateInput,
} from '../../../../src/compat/tools/tasks/schemas.js'

describe('tasks/schemas', () => {
  it('TaskCreateInput accepts subject + optional description/activeForm', () => {
    expect(() => TaskCreateInput.parse({ subject: 'Fix bug' })).not.toThrow()
    expect(() =>
      TaskCreateInput.parse({ subject: 'X', description: 'd', activeForm: 'a' }),
    ).not.toThrow()
  })

  it('TaskCreateInput rejects empty subject', () => {
    expect(() => TaskCreateInput.parse({ subject: '' })).toThrow()
  })

  it('TaskGetInput rejects malformed id', () => {
    expect(() => TaskGetInput.parse({ id: 'has space' })).toThrow()
    expect(() => TaskGetInput.parse({ id: 'a'.repeat(33) })).toThrow()
    expect(() => TaskGetInput.parse({ id: 'abc-123' })).not.toThrow()
  })

  it('TaskUpdateInput rejects unknown status', () => {
    expect(() =>
      TaskUpdateInput.parse({ id: 'abc-123', status: 'unknown' }),
    ).toThrow()
  })

  it('TaskUpdateInput accepts partial patch', () => {
    expect(() => TaskUpdateInput.parse({ id: 'abc-123' })).not.toThrow()
    expect(() =>
      TaskUpdateInput.parse({ id: 'abc-123', subject: 'New' }),
    ).not.toThrow()
  })

  it('TaskListInput accepts empty object', () => {
    expect(() => TaskListInput.parse({})).not.toThrow()
  })
})
