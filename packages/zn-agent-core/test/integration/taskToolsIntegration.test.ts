import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDefaultTools } from '../../src/compat/tools/index.js'
import { setTaskListStore, TaskListStore } from '../../src/compat/taskListStore.js'
import { TaskCreateTool } from '../../src/compat/tools/tasks/TaskCreateTool.js'
import { TaskUpdateTool } from '../../src/compat/tools/tasks/TaskUpdateTool.js'
import { TaskListTool } from '../../src/compat/tools/tasks/TaskListTool.js'
import {
  resetStateChangeBusForTests,
  stateChangeBus,
} from '../../src/stateChangeBus.js'

describe('task tools integration (end-to-end through stateChangeBus)', () => {
  let tmpDir: string
  let store: TaskListStore
  let emitted: Array<{ type: string; payload: unknown }>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'task-integration-'))
    store = new TaskListStore(tmpDir)
    setTaskListStore(store)
    // 清空前一轮残留的 listener,避免 N 个 test 累积 N 个监听
    resetStateChangeBusForTests()
    emitted = []
    stateChangeBus.on('v2_task.changed', (payload) => {
      emitted.push({ type: 'v2_task.changed', payload })
    })
  })
  afterEach(() => {
    setTaskListStore(null)
    resetStateChangeBusForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('merged tool list contains TaskCreate/Get/Update/List', () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']),
    )
  })

  it('TaskCreate persists and emits v2_task.changed with action=upsert', async () => {
    const result = (await TaskCreateTool.call(
      { subject: 'integration works' },
      { sessionId: 'sess-int-X' },
    )) as { output: string }
    const created = JSON.parse(result.output)
    expect(created.id).toMatch(/^[a-zA-Z0-9_-]{1,32}$/)
    expect(created.subject).toBe('integration works')
    expect(created.status).toBe('pending')

    expect(emitted).toHaveLength(1)
    const evt = emitted[0].payload as {
      sessionId: string
      task: { id: string; subject: string }
      action: 'upsert' | 'delete'
    }
    expect(evt.sessionId).toBe('sess-int-X')
    expect(evt.action).toBe('upsert')
    expect(evt.task.id).toBe(created.id)
    expect(evt.task.subject).toBe('integration works')
  })

  it('TaskUpdate emits a second v2_task.changed with merged patch', async () => {
    const createRes = (await TaskCreateTool.call(
      { subject: 'before' },
      { sessionId: 'sess-int-Y' },
    )) as { output: string }
    const created = JSON.parse(createRes.output)
    emitted.length = 0

    const updateRes = (await TaskUpdateTool.call(
      { id: created.id, status: 'in_progress', subject: 'after' },
      { sessionId: 'sess-int-Y' },
    )) as { output: string }
    const updated = JSON.parse(updateRes.output)
    expect(updated.status).toBe('in_progress')
    expect(updated.subject).toBe('after')

    expect(emitted).toHaveLength(1)
    const evt = emitted[0].payload as {
      task: { status: string; subject: string }
      action: 'upsert'
    }
    expect(evt.action).toBe('upsert')
    expect(evt.task.status).toBe('in_progress')
    expect(evt.task.subject).toBe('after')
  })

  it('TaskList returns the persisted tasks (no events fired on read)', async () => {
    await TaskCreateTool.call({ subject: 'one' }, { sessionId: 'sess-int-Z' })
    await TaskCreateTool.call({ subject: 'two' }, { sessionId: 'sess-int-Z' })
    emitted.length = 0

    const listRes = (await TaskListTool.call({}, { sessionId: 'sess-int-Z' })) as {
      output: string
    }
    const list = JSON.parse(listRes.output) as Array<{ subject: string }>
    expect(list).toHaveLength(2)
    const subjects = list.map((t) => t.subject).sort()
    expect(subjects).toEqual(['one', 'two'])
    // TaskList 不触发 v2_task.changed — 它是只读。
    expect(emitted).toHaveLength(0)
  })

  it('events are scoped to the right sessionId', async () => {
    await TaskCreateTool.call({ subject: 'private' }, { sessionId: 'sess-A' })
    emitted.length = 0
    await TaskCreateTool.call({ subject: 'other' }, { sessionId: 'sess-B' })
    expect(emitted).toHaveLength(1)
    const evt = emitted[0].payload as { sessionId: string }
    expect(evt.sessionId).toBe('sess-B')
  })
})