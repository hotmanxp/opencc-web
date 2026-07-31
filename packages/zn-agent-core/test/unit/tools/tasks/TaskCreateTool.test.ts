import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskCreateTool } from '../../../../src/compat/tools/tasks/TaskCreateTool.js'
import { setTaskListStore, TaskListStore } from '../../../../src/compat/taskListStore.js'

describe('TaskCreateTool', () => {
  let tmpDir: string
  let store: TaskListStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'task-create-tool-'))
    store = new TaskListStore(tmpDir)
    setTaskListStore(store)
  })
  afterEach(() => {
    setTaskListStore(null)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a task with id and pending status, returns JSON', async () => {
    const result = await TaskCreateTool.call(
      { subject: 'Write tests', description: 'cover schemas', activeForm: 'Writing tests' },
      { sessionId: 'sess-A' },
    )
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed.id).toMatch(/^[a-zA-Z0-9_-]{1,32}$/)
    expect(parsed.subject).toBe('Write tests')
    expect(parsed.status).toBe('pending')
    expect(parsed.sessionId).toBe('sess-A')
    expect(parsed.createdAt).toBeGreaterThan(0)
  })

  it('persists to disk under tasks/<sessionId>.json', async () => {
    await TaskCreateTool.call({ subject: 'persist me' }, { sessionId: 'sess-P' })
    const list = await store.list('sess-P')
    expect(list).toHaveLength(1)
    expect(list[0].subject).toBe('persist me')
  })

  it('throws when sessionId is missing', async () => {
    await expect(
      TaskCreateTool.call({ subject: 'no session' }, {}),
    ).rejects.toThrow(/requires sessionId/)
  })

  it('returns invalid-input error string when subject is empty', async () => {
    const result = await TaskCreateTool.call({ subject: '' }, { sessionId: 'sess-X' })
    expect((result as { output: string }).output).toMatch(/invalid input for TaskCreate/)
  })
})
