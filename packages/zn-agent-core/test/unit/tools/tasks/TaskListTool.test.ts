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
    expect((result as { output: string }).output).toBe('[]')
  })

  it('returns all non-deleted tasks for the session', async () => {
    await store.create('sess-A', { subject: 'first' })
    await store.create('sess-A', { subject: 'second' })
    const result = await TaskListTool.call({}, { sessionId: 'sess-A' })
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed).toHaveLength(2)
    expect(parsed.map((t: { subject: string }) => t.subject).sort()).toEqual(['first', 'second'])
  })

  it('returns sorted by createdAt ascending', async () => {
    const a = await store.create('sess-A', { subject: 'a' })
    // ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 2))
    const b = await store.create('sess-A', { subject: 'b' })
    const result = await TaskListTool.call({}, { sessionId: 'sess-A' })
    const parsed = JSON.parse((result as { output: string }).output) as Array<{ id: string }>
    expect(parsed.map((t) => t.id)).toEqual([a.id, b.id])
  })

  it('filters out deleted tasks', async () => {
    const a = await store.create('sess-A', { subject: 'a' })
    await store.create('sess-A', { subject: 'b' })
    await store.update('sess-A', a.id, { status: 'deleted' })
    const result = await TaskListTool.call({}, { sessionId: 'sess-A' })
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].subject).toBe('b')
  })

  it('only returns tasks for the current session', async () => {
    await store.create('sess-A', { subject: 'A-only' })
    await store.create('sess-B', { subject: 'B-only' })
    const result = await TaskListTool.call({}, { sessionId: 'sess-A' })
    const parsed = JSON.parse((result as { output: string }).output)
    expect(parsed.map((t: { subject: string }) => t.subject)).toEqual(['A-only'])
  })

  it('throws when sessionId is missing', async () => {
    await expect(TaskListTool.call({}, {})).rejects.toThrow(/requires sessionId/)
  })
})
