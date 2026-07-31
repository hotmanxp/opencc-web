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

  it('updates status to in_progress and returns updated task', async () => {
    const created = await store.create('sess-A', { subject: 'update me' })
    const result = await TaskUpdateTool.call(
      { id: created.id, status: 'in_progress' },
      { sessionId: 'sess-A' },
    )
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed.status).toBe('in_progress')
    expect(parsed.id).toBe(created.id)
    expect(parsed.updatedAt).toBeGreaterThanOrEqual(parsed.createdAt)
  })

  it('updates subject and activeForm', async () => {
    const created = await store.create('sess-A', { subject: 'old' })
    const result = await TaskUpdateTool.call(
      { id: created.id, subject: 'new', activeForm: 'Updating' },
      { sessionId: 'sess-A' },
    )
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed.subject).toBe('new')
    expect(parsed.activeForm).toBe('Updating')
  })

  it('returns "null" string for missing id', async () => {
    const result = await TaskUpdateTool.call(
      { id: 'nonexistent', status: 'completed' },
      { sessionId: 'sess-A' },
    )
    expect((result as { output: string }).output).toBe('null')
  })

  it('returns "null" when id belongs to another session', async () => {
    const created = await store.create('sess-A', { subject: 'private' })
    const result = await TaskUpdateTool.call(
      { id: created.id, status: 'completed' },
      { sessionId: 'sess-B' },
    )
    expect((result as { output: string }).output).toBe('null')
  })

  it('triggers auto-cleanup when last task reaches completed', async () => {
    const created = await store.create('sess-A', { subject: 'finish' })
    await TaskUpdateTool.call(
      { id: created.id, status: 'completed' },
      { sessionId: 'sess-A' },
    )
    const after = await store.list('sess-A')
    expect(after).toEqual([])
  })

  it('throws when sessionId is missing', async () => {
    await expect(
      TaskUpdateTool.call({ id: 'abc', status: 'completed' }, {}),
    ).rejects.toThrow(/requires sessionId/)
  })

  it('returns invalid-input error for unknown status', async () => {
    const created = await store.create('sess-A', { subject: 'x' })
    const result = await TaskUpdateTool.call(
      { id: created.id, status: 'deleted' as never },
      { sessionId: 'sess-A' },
    )
    expect((result as { output: string }).output).toMatch(/invalid input for TaskUpdate/)
  })
})
