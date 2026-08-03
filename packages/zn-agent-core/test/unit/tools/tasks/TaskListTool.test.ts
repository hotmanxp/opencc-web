import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setTaskListStore, TaskListStore } from '../../../../src/compat/taskListStore.js'
import { TaskListTool } from '../../../../src/compat/tools/tasks/TaskListTool.js'

describe('TaskListTool', () => {
  let tmpDir: string
  let store: TaskListStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'task-list-tool-'))
    store = new TaskListStore(tmpDir)
    setTaskListStore(store)
  })
  afterEach(() => {
    setTaskListStore(null)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array when no tasks exist', async () => {
    const result = await TaskListTool.call({}, { sessionId: 'sess-A' })
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed).toEqual([])
  })

  it('returns all non-deleted tasks for the current session', async () => {
    await store.create('sess-A', { subject: 'one' })
    await store.create('sess-A', { subject: 'two' })
    await store.create('sess-B', { subject: 'private' })
    const result = await TaskListTool.call({}, { sessionId: 'sess-A' })
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed).toHaveLength(2)
    const subjects = parsed.map((t: { subject: string }) => t.subject).sort()
    expect(subjects).toEqual(['one', 'two'])
  })

  it('omits tasks marked as deleted', async () => {
    const created = await store.create('sess-A', { subject: 'gone' })
    await store.create('sess-A', { subject: 'alive' })
    await store.update('sess-A', created.id, { status: 'deleted' })
    const result = await TaskListTool.call({}, { sessionId: 'sess-A' })
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].subject).toBe('alive')
  })

  it('throws when sessionId is missing', async () => {
    await expect(TaskListTool.call({}, {})).rejects.toThrow(/requires sessionId/)
  })
})