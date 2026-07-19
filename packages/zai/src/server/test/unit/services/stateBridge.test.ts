import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  stateChangeBus,
  resetStateChangeBusForTests,
} from '@zn-ai/zai-agent-core/runtime'
import { eventBus } from '../../../services/eventBus.js'
import {
  initStateBridge,
  __resetStateBridgeForTests,
} from '../../../services/stateBridge.js'

describe('stateBridge', () => {
  beforeEach(() => {
    resetStateChangeBusForTests()
    __resetStateBridgeForTests()
    vi.spyOn(eventBus, 'emit')
  })

  afterEach(() => {
    __resetStateBridgeForTests()
    vi.restoreAllMocks()
  })

  it('bridges cwd.changed to eventBus.emit', () => {
    initStateBridge()
    stateChangeBus.emit('cwd.changed', { sessionId: 's1', cwd: '/tmp', updatedAt: 1 })
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: 'cwd.changed',
      sessionId: 's1',
      cwd: '/tmp',
      updatedAt: 1,
    })
  })

  it('bridges bash_task.changed to eventBus.emit', () => {
    initStateBridge()
    const task = { taskId: 'bash-1' }
    stateChangeBus.emit('bash_task.changed', { sessionId: 's1', task: task as any })
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: 'bash_task.changed',
      sessionId: 's1',
      task,
    })
  })

  it('bridges v2_task.changed with action field', () => {
    initStateBridge()
    const task = { id: 't1' }
    stateChangeBus.emit('v2_task.changed', { sessionId: 's1', task: task as any, action: 'upsert' })
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: 'v2_task.changed',
      sessionId: 's1',
      task,
      action: 'upsert',
    })
  })

  it('bridges agent_task.changed with nullable sessionId', () => {
    initStateBridge()
    const task = { id: 'a1' }
    stateChangeBus.emit('agent_task.changed', { sessionId: null, task: task as any })
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: 'agent_task.changed',
      sessionId: null,
      task,
    })
  })

  it('dispose stops forwarding', () => {
    const dispose = initStateBridge()
    dispose()
    stateChangeBus.emit('cwd.changed', { sessionId: 's1', cwd: '/tmp', updatedAt: 1 })
    expect(eventBus.emit).not.toHaveBeenCalled()
  })
})
