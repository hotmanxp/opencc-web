import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  stateChangeBus,
  resetStateChangeBusForTests,
} from '../../../src/runtime/stateChangeBus.js'

describe('stateChangeBus', () => {
  beforeEach(() => {
    resetStateChangeBusForTests()
  })

  it('emits cwd.changed with payload', () => {
    const cb = vi.fn()
    stateChangeBus.on('cwd.changed', cb)
    stateChangeBus.emit('cwd.changed', { sessionId: 's1', cwd: '/tmp', updatedAt: 1000 })
    expect(cb).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp', updatedAt: 1000 })
  })

  it('emits bash_task.changed with payload', () => {
    const cb = vi.fn()
    stateChangeBus.on('bash_task.changed', cb)
    stateChangeBus.emit('bash_task.changed', { sessionId: 's1', task: {} as any })
    expect(cb).toHaveBeenCalledWith({ sessionId: 's1', task: {} })
  })

  it('emits v2_task.changed with payload', () => {
    const cb = vi.fn()
    stateChangeBus.on('v2_task.changed', cb)
    stateChangeBus.emit('v2_task.changed', { sessionId: 's1', task: {} as any, action: 'upsert' })
    expect(cb).toHaveBeenCalledWith({ sessionId: 's1', task: {}, action: 'upsert' })
  })

  it('emits agent_task.changed with nullable sessionId', () => {
    const cb = vi.fn()
    stateChangeBus.on('agent_task.changed', cb)
    stateChangeBus.emit('agent_task.changed', { sessionId: null, task: {} as any })
    expect(cb).toHaveBeenCalledWith({ sessionId: null, task: {} })
  })

  it('off removes listener', () => {
    const cb = vi.fn()
    stateChangeBus.on('cwd.changed', cb)
    stateChangeBus.off('cwd.changed', cb)
    stateChangeBus.emit('cwd.changed', { sessionId: 's1', cwd: '/tmp', updatedAt: 1000 })
    expect(cb).not.toHaveBeenCalled()
  })

  it('resetStateChangeBusForTests removes all listeners', () => {
    const cb = vi.fn()
    stateChangeBus.on('cwd.changed', cb)
    stateChangeBus.on('bash_task.changed', cb)
    resetStateChangeBusForTests()
    stateChangeBus.emit('cwd.changed', { sessionId: 's1', cwd: '/tmp', updatedAt: 1000 })
    stateChangeBus.emit('bash_task.changed', { sessionId: 's1', task: {} as any })
    expect(cb).not.toHaveBeenCalled()
  })
})