import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initTaskFactoryBridge, getTaskFactoryState, setTaskFactoryState, injectSupervisorCommand, __resetForTests,
} from '../../../src/server/services/taskFactoryBridge.js'
import { eventBus } from '../../../src/server/services/eventBus.js'
import { sessionInbox } from '../../../src/server/services/sessionInbox.js'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tf-bridge-'))
  process.env.ZAI_TASK_FACTORY_DIR = dir
})
afterAll(async () => {
  delete process.env.ZAI_TASK_FACTORY_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('taskFactoryBridge', () => {
  it('set/get state 持久化到 state.json', async () => {
    __resetForTests()
    await setTaskFactoryState({ managedEnabled: true, supervisorSessionId: 'sess-sup' })
    const s = await getTaskFactoryState()
    expect(s.managedEnabled).toBe(true)
    expect(s.supervisorSessionId).toBe('sess-sup')
    const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'))
    expect(raw.managedEnabled).toBe(true)
  })

  it('emitter 事件经 eventBus 发出', () => {
    __resetForTests()
    const spy = vi.spyOn(eventBus, 'emit')
    initTaskFactoryBridge()
    const emitter = (globalThis as any).__zaiTaskFactoryEmitter
    emitter({ action: 'created', payload: { id: 'tf-x' } })
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_factory', action: 'created' }))
  })

  it('injectSupervisorCommand 走 sessionInbox.followup', async () => {
    __resetForTests()
    await setTaskFactoryState({ managedEnabled: false, supervisorSessionId: 'sess-sup' })
    const spy = vi.spyOn(sessionInbox, 'followup')
    injectSupervisorCommand('<task-command action="dispatch"></task-command>')
    expect(spy).toHaveBeenCalledWith(
      'sess-sup',
      expect.objectContaining({
        source: expect.objectContaining({ kind: 'task-factory' }),
        content: expect.stringContaining('task-command'),
      }),
    )
  })
})
