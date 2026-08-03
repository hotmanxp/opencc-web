import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setTaskListStore, TaskListStore } from '../../../../src/compat/taskListStore.js'
import { TaskUpdateTool } from '../../../../src/compat/tools/tasks/TaskUpdateTool.js'

describe('TaskUpdateTool', () => {
  let tmpDir: string
  let store: TaskListStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'task-update-tool-'))
    store = new TaskListStore(tmpDir)
    setTaskListStore(store)
  })
  afterEach(() => {
    setTaskListStore(null)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('updates an existing task status', async () => {
    const created = await store.create('sess-A', { subject: 'do thing' })
    const result = await TaskUpdateTool.call(
      { id: created.id, status: 'in_progress' },
      { sessionId: 'sess-A' },
    )
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed.id).toBe(created.id)
    expect(parsed.status).toBe('in_progress')
  })

  it('replaces subject and activeForm', async () => {
    const created = await store.create('sess-A', { subject: 'old' })
    const result = await TaskUpdateTool.call(
      { id: created.id, subject: 'new', activeForm: 'Doing new' },
      { sessionId: 'sess-A' },
    )
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed.subject).toBe('new')
    expect(parsed.activeForm).toBe('Doing new')
  })

  it('returns error string when task does not exist', async () => {
    const result = await TaskUpdateTool.call(
      { id: 'missing', status: 'completed' },
      { sessionId: 'sess-A' },
    )
    expect((result as { output: string }).output).toMatch(/task not found/)
  })

  it('returns error string when id belongs to another session', async () => {
    const created = await store.create('sess-A', { subject: 'private' })
    const result = await TaskUpdateTool.call(
      { id: created.id, status: 'completed' },
      { sessionId: 'sess-B' },
    )
    expect((result as { output: string }).output).toMatch(/task not found/)
  })

  it('throws when sessionId is missing', async () => {
    await expect(
      TaskUpdateTool.call({ id: 'abc' }, {}),
    ).rejects.toThrow(/requires sessionId/)
  })

  it('returns invalid-input error for unknown status', async () => {
    const created = await store.create('sess-A', { subject: 'x' })
    const result = await TaskUpdateTool.call(
      { id: created.id, status: 'unknown' as never },
      { sessionId: 'sess-A' },
    )
    expect((result as { output: string }).output).toMatch(/invalid input for TaskUpdate/)
  })
})