import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runOpenccQuery } from '../../src/compat/runtime/openccAdapter.js'
import { buildDefaultTools } from '../../src/compat/tools/index.js'
import { setTaskListStore, TaskListStore } from '../../src/compat/taskListStore.js'
import { stateChangeBus } from '../../src/stateChangeBus.js'

describe('runOpenccQuery with task tools', () => {
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

  function fakeModelCaller(callSequence: Array<{ type: string; [k: string]: unknown }>) {
    let i = 0
    return async () => {
      const events = callSequence[i++] ?? [{ type: 'message_stop' }]
      return (async function* () {
        for (const e of events) yield e as never
      })()
    }
  }

  it('merged tool list contains TaskCreate/Get/Update/List', async () => {
    const tools = buildDefaultTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']))
  })

  it('runOpenccQuery passes task tools to modelCaller', async () => {
    let receivedTools: Array<{ name: string }> = []
    const modelCaller = async (req: { tools?: Array<{ name: string }> }) => {
      receivedTools = req.tools ?? []
      return (async function* () {
        yield { type: 'message_stop' }
      })()
    }
    const events: unknown[] = []
    for await (const ev of runOpenccQuery(
      {
        prompt: 'noop',
        cwd: tmpDir,
        transcriptId: 'sess-int-A',
        sessionId: 'sess-int-A',
      },
      {
        modelCaller: modelCaller as never,
        tools: buildDefaultTools(),
      },
    )) {
      events.push(ev)
    }
    expect(receivedTools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']),
    )
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