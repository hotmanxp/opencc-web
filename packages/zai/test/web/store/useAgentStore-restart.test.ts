import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../../src/web/src/store/useAppStore.js'
import { useAgentStore } from '../../../src/web/src/store/useAgentStore.js'

describe('useAgentStore system.restarting event', () => {
  afterEach(() => {
    useAppStore.getState().setServiceState(null)
  })

  it('system.restarting surfaces in useAppStore.serviceState with deadline', () => {
    const deadline = Date.now() + 5_000
    useAppStore.getState().applySystemEvent({
      type: 'system.restarting',
      eventId: 'e1',
      ts: Date.now(),
      reason: 'user_action',
      deadlineMs: deadline,
    })
    const s = useAppStore.getState().serviceState
    expect(s?.phase).toBe('restarting')
    expect(s?.reason).toBe('user_action')
    expect(s?.deadlineMs).toBe(deadline)
  })

  it('system.restart.canceled clears useAppStore.serviceState', () => {
    useAppStore.getState().setServiceState({ phase: 'restarting', reason: 'auto_recovery', deadlineMs: 1 })
    useAppStore.getState().applySystemEvent({
      type: 'system.restart.canceled',
      eventId: 'e2',
      ts: Date.now(),
    })
    expect(useAppStore.getState().serviceState).toBeNull()
  })

  it('useAgentStore does not own serviceState — restart lives in useAppStore', () => {
    // 验证 useAgentStore 不持有 serviceState,真实路径走 useAppStore.applySystemEvent
    // (与 useEventStream.dispatch 路由一致: useEventStream → useAppStore.applySystemEvent).
    expect((useAgentStore.getState() as { serviceState?: unknown }).serviceState).toBeUndefined()
  })
})
