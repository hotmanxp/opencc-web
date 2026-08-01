import { describe, expect, it } from 'bun:test'
import { useAppStore } from '../../../src/web/src/store/useAppStore.js'

describe('useAppStore service state', () => {
  it('starts with serviceState == null', () => {
    expect(useAppStore.getState().serviceState).toBeNull()
  })

  it('setServiceState persists value', () => {
    useAppStore.getState().setServiceState({ phase: 'restarting', reason: 'user_action', deadlineMs: 0 })
    expect(useAppStore.getState().serviceState?.phase).toBe('restarting')
  })
})
