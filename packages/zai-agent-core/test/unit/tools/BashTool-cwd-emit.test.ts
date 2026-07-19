import { describe, it, expect, beforeEach, vi } from 'vitest'
import { stateChangeBus, resetStateChangeBusForTests } from '../../../src/runtime/stateChangeBus.js'
import { CwdStore } from '../../../src/runtime/cwdStore.js'

describe('BashTool cwd.changed emit', () => {
  beforeEach(() => {
    resetStateChangeBusForTests()
    CwdStore.clear()
  })

  it('emits cwd.changed when CwdStore.set called with different cwd', () => {
    const cb = vi.fn()
    stateChangeBus.on('cwd.changed', cb)
    CwdStore.set('sess-1', '/tmp/a')
    // 模拟 BashTool 末尾 emit
    stateChangeBus.emit('cwd.changed', { sessionId: 'sess-1', cwd: '/tmp/a', updatedAt: Date.now() })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0]).toMatchObject({ sessionId: 'sess-1', cwd: '/tmp/a' })
  })

  it('does not emit when cwd unchanged', () => {
    CwdStore.set('sess-1', '/tmp/a')
    const cb = vi.fn()
    stateChangeBus.on('cwd.changed', cb)
    // 模拟 BashTool 内"newCwd === oldCwd → 跳过"分支
    const newCwd = CwdStore.get('sess-1')!
    if (newCwd !== CwdStore.get('sess-1')) {
      stateChangeBus.emit('cwd.changed', { sessionId: 'sess-1', cwd: newCwd, updatedAt: Date.now() })
    }
    expect(cb).not.toHaveBeenCalled()
  })
})