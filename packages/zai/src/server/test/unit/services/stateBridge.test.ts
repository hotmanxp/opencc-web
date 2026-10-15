import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  stateChangeBus,
  resetStateChangeBusForTests,
} from '@zn-ai/zn-agent-core'
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

  // zai patch (2026-10-12): 压缩过程态的桥接。手动 /compact 与自动压缩
  // **同源** —— 两边都从 vendor compactConversation 的过程信号出发, 经 core
  // 的 createCompactProgressEmitter 转成 compact.changed, 由这一个订阅
  // 统一翻成 ServerEvent。
  it('bridges compact.changed to runtime.compacting', () => {
    initStateBridge()
    stateChangeBus.emit('compact.changed', { sessionId: 's1', compacting: true })
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: 'runtime.compacting',
      sessionId: 's1',
      compacting: true,
    })
    stateChangeBus.emit('compact.changed', { sessionId: 's1', compacting: false })
    expect(eventBus.emit).toHaveBeenLastCalledWith({
      type: 'runtime.compacting',
      sessionId: 's1',
      compacting: false,
    })
  })

  it('compact.changed 也不受 dispose 影响地停止转发', () => {
    const dispose = initStateBridge()
    dispose()
    stateChangeBus.emit('compact.changed', { sessionId: 's1', compacting: true })
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('dispose stops forwarding', () => {
    const dispose = initStateBridge()
    dispose()
    stateChangeBus.emit('cwd.changed', { sessionId: 's1', cwd: '/tmp', updatedAt: 1 })
    expect(eventBus.emit).not.toHaveBeenCalled()
  })
})
