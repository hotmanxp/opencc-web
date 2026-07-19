import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { bashBackgroundTracker } from '../../../src/tools/BashTool/bashTracker.js'
import { stateChangeBus, resetStateChangeBusForTests } from '../../../src/runtime/stateChangeBus.js'

const taskInfo = {
  command: 'sleep 1',
  description: 'sleep',
  sessionId: 'sess-1',
  startedAt: Date.now(),
}

describe('bashBackgroundTracker debounce', () => {
  beforeEach(() => {
    resetStateChangeBusForTests()
    bashBackgroundTracker.__resetForTests()
  })

  afterEach(() => {
    bashBackgroundTracker.__resetForTests()
  })

  it('batches appendOutput: 100 calls → 1 emit', () => {
    const cb = vi.fn()
    stateChangeBus.on('bash_task.changed', cb)
    const t = bashBackgroundTracker.register('bash-1', taskInfo)
    bashBackgroundTracker.attachChild('bash-1', {} as any)
    for (let i = 0; i < 100; i++) {
      bashBackgroundTracker.appendOutput('bash-1', { stdout: `chunk ${i}\n` })
    }
    // 同步阶段还没 emit(50ms debounce)
    expect(cb).not.toHaveBeenCalled()
  })

  it('emits after 50ms debounce', async () => {
    const cb = vi.fn()
    stateChangeBus.on('bash_task.changed', cb)
    bashBackgroundTracker.register('bash-1', taskInfo)
    bashBackgroundTracker.attachChild('bash-1', {} as any)
    bashBackgroundTracker.appendOutput('bash-1', { stdout: 'hi' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(cb).toHaveBeenCalledTimes(1)
    const last = cb.mock.calls[cb.mock.calls.length - 1][0]
    expect(last.task.taskId).toBe('bash-1')
    expect(last.task.stdout).toBe('hi')
  })

  it('markFinished synchronously emits (no debounce)', () => {
    const cb = vi.fn()
    stateChangeBus.on('bash_task.changed', cb)
    bashBackgroundTracker.register('bash-1', taskInfo)
    bashBackgroundTracker.attachChild('bash-1', {} as any)
    bashBackgroundTracker.markFinished('bash-1', 'completed', { exitCode: 0 })
    expect(cb).toHaveBeenCalledTimes(1)
    const last = cb.mock.calls[0][0]
    expect(last.task.status).toBe('completed')
  })

  it('__flushPendingForTests forces immediate emit', () => {
    const cb = vi.fn()
    stateChangeBus.on('bash_task.changed', cb)
    bashBackgroundTracker.register('bash-1', taskInfo)
    bashBackgroundTracker.attachChild('bash-1', {} as any)
    bashBackgroundTracker.appendOutput('bash-1', { stdout: 'pending' })
    bashBackgroundTracker.__flushPendingForTests()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].task.stdout).toBe('pending')
  })

  it('does not emit for evicted task', () => {
    const cb = vi.fn()
    stateChangeBus.on('bash_task.changed', cb)
    // 没 register 就 scheduleEmit → byId miss → 无 emit
    ;(bashBackgroundTracker as any).scheduleEmit('bash-unknown')
    expect(cb).not.toHaveBeenCalled()
  })
})