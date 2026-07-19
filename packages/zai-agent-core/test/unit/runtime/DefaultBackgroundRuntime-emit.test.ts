import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DefaultBackgroundRuntime } from '../../../src/runtime/background/DefaultBackgroundRuntime.js'
import { stateChangeBus, resetStateChangeBusForTests } from '../../../src/runtime/stateChangeBus.js'
import type { BackgroundTask } from '../../../src/runtime/background/types.js'

describe('DefaultBackgroundRuntime emit agent_task.changed', () => {
  beforeEach(() => {
    resetStateChangeBusForTests()
  })

  it('notifyChange emits agent_task.changed with parentSessionId', () => {
    const cb = vi.fn()
    stateChangeBus.on('agent_task.changed', cb)
    const fakeRuntime = {} as any
    const fakeStore = { save: async () => {}, appendEvent: async () => {} } as any
    const rt = new DefaultBackgroundRuntime({
      agentRuntime: fakeRuntime,
      store: fakeStore,
      onTaskStateChange: () => {},
    })
    const task = { id: 't1', parentSessionId: 'sess-1', status: 'running' } as BackgroundTask
    ;(rt as any).notifyChange(task)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0]).toMatchObject({ sessionId: 'sess-1', task })
  })

  it('notifyChange with null parentSessionId emits sessionId: null', () => {
    const cb = vi.fn()
    stateChangeBus.on('agent_task.changed', cb)
    const rt = new DefaultBackgroundRuntime({
      agentRuntime: {} as any,
      store: { save: async () => {}, appendEvent: async () => {} } as any,
      onTaskStateChange: () => {},
    })
    const task = { id: 't1', status: 'running' } as BackgroundTask
    ;(rt as any).notifyChange(task)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].sessionId).toBeNull()
  })

  it('onTaskStateChange callback still fires (parallel with emit)', () => {
    const onCb = vi.fn()
    const busCb = vi.fn()
    stateChangeBus.on('agent_task.changed', busCb)
    const rt = new DefaultBackgroundRuntime({
      agentRuntime: {} as any,
      store: { save: async () => {}, appendEvent: async () => {} } as any,
      onTaskStateChange: onCb,
    })
    const task = { id: 't1', parentSessionId: 'sess-1', status: 'running' } as BackgroundTask
    ;(rt as any).notifyChange(task)
    expect(onCb).toHaveBeenCalledTimes(1)
    expect(busCb).toHaveBeenCalledTimes(1)
  })
})
