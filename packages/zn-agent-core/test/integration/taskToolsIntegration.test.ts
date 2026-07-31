import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDefaultTools } from '../../src/compat/tools/index.js'
import { setTaskListStore, TaskListStore } from '../../src/compat/taskListStore.js'
import { stateChangeBus } from '../../src/stateChangeBus.js'

describe('task tools integration', () => {
  let tmpDir: string
  let store: TaskListStore
  let emitted: Array<unknown>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'task-integration-'))
    store = new TaskListStore(tmpDir)
    setTaskListStore(store)
    const localEmitted: Array<unknown> = []
    emitted = localEmitted
    stateChangeBus.on('v2_task.changed', (payload) => localEmitted.push(payload))
  })
  afterEach(() => {
    setTaskListStore(null)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('merged tool list contains TaskCreate/Get/Update/List', async () => {
    const tools = buildDefaultTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']))
  })

  it('TaskCreate via store persists and emits stateChangeBus event', async () => {
    await store.create('sess-int-X', { subject: 'integration works' })
    // The store create() also fires the event — verify both write + emit:
    expect(emitted.length).toBe(1)
    const list = await store.list('sess-int-X')
    expect(list).toHaveLength(1)
    expect(list[0].subject).toBe('integration works')
  })
})