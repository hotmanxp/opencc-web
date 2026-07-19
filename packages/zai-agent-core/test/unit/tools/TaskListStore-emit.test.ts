import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskListStore, setTaskListStore } from '../../../src/tools/Tasks/TaskListStore.js'
import { stateChangeBus, resetStateChangeBusForTests } from '../../../src/runtime/stateChangeBus.js'

describe('TaskListStore emit v2_task.changed', () => {
  let store: TaskListStore
  let dir: string
  let emits: Array<{ sessionId: string; task: any; action: string }>

  beforeEach(() => {
    resetStateChangeBusForTests()
    emits = []
    stateChangeBus.on('v2_task.changed', (e) => emits.push(e))
    dir = mkdtempSync(join(tmpdir(), 'tls-test-'))
    store = new TaskListStore(dir)
    setTaskListStore(store)
  })

  it('create emits upsert', async () => {
    const task = await store.create('sess-1', { subject: 'do thing' })
    expect(emits).toHaveLength(1)
    expect(emits[0]).toMatchObject({ sessionId: 'sess-1', action: 'upsert' })
    expect(emits[0].task.id).toBe(task.id)
  })

  it('update emits upsert', async () => {
    const task = await store.create('sess-1', { subject: 'do thing' })
    emits.length = 0
    const updated = await store.update('sess-1', task.id, { status: 'in_progress' })
    expect(updated).not.toBeNull()
    expect(emits).toHaveLength(1)
    expect(emits[0].action).toBe('upsert')
    expect(emits[0].task.status).toBe('in_progress')
  })

  it('update → completed (all terminal) emits upsert then delete', async () => {
    const task = await store.create('sess-1', { subject: 'thing' })
    emits.length = 0
    await store.update('sess-1', task.id, { status: 'completed' })
    expect(emits).toHaveLength(2)
    expect(emits[0].action).toBe('upsert')
    expect(emits[0].task.status).toBe('completed')
    expect(emits[1].action).toBe('delete')
    expect(emits[1].task.id).toBe(task.id)
  })

  it('deleteSession emits delete', async () => {
    const task = await store.create('sess-1', { subject: 'thing' })
    emits.length = 0
    await store.deleteSession('sess-1')
    expect(emits).toHaveLength(1)
    expect(emits[0].action).toBe('delete')
    expect(emits[0].task.id).toBe(task.id)
  })

  afterEach(() => {
    setTaskListStore(null)
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
})