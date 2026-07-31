import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setTaskListStore, TaskListStore } from '../../../../src/compat/taskListStore.js'
import { TaskGetTool } from '../../../../src/compat/tools/tasks/TaskGetTool.js'

describe('TaskGetTool', () => {
  let tmpDir: string
  let store: TaskListStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'task-get-tool-'))
    store = new TaskListStore(tmpDir)
    setTaskListStore(store)
  })
  afterEach(() => {
    setTaskListStore(null)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns existing task by id', async () => {
    const created = await store.create('sess-A', { subject: 'get me' })
    const result = await TaskGetTool.call(
      { id: created.id },
      { sessionId: 'sess-A' },
    )
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed.id).toBe(created.id)
    expect(parsed.subject).toBe('get me')
  })

  it('returns error string for missing id', async () => {
    const result = await TaskGetTool.call(
      { id: 'nonexistent' },
      { sessionId: 'sess-A' },
    )
    expect((result as { output: string }).output).toMatch(/task not found/)
  })

  it('returns error string when id belongs to another session', async () => {
    const created = await store.create('sess-A', { subject: 'private' })
    const result = await TaskGetTool.call(
      { id: created.id },
      { sessionId: 'sess-B' },
    )
    expect((result as { output: string }).output).toMatch(/task not found/)
  })

  it('throws when sessionId is missing', async () => {
    await expect(
      TaskGetTool.call({ id: 'abc' }, {}),
    ).rejects.toThrow(/requires sessionId/)
  })

  it('returns invalid-input error for malformed id', async () => {
    const result = await TaskGetTool.call(
      { id: 'has space' },
      { sessionId: 'sess-A' },
    )
    expect((result as { output: string }).output).toMatch(/invalid input for TaskGet/)
  })
})
