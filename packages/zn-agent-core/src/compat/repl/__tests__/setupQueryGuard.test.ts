// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L2 QueryGuardState tests.
 * See Task 5 brief.
 */

import { setupQueryGuard } from '../setup/setupQueryGuard.js'

describe('setupQueryGuard', () => {
  it('tryStart returns generation token; second concurrent call returns null', () => {
    const { state, teardown } = setupQueryGuard()
    const gen1 = state.tryStart()
    expect(gen1).not.toBeNull()
    const gen2 = state.tryStart()
    expect(gen2).toBeNull()
    state.end(gen1!)
    teardown()
  })

  it('end with correct generation clears state and returns true', () => {
    const { state, teardown } = setupQueryGuard()
    const gen1 = state.tryStart()
    expect(state.isActive).toBe(true)
    const result = state.end(gen1!)
    expect(result).toBe(true)
    expect(state.isActive).toBe(false)
    teardown()
  })

  it('end with wrong generation returns false and does not clear state', () => {
    const { state, teardown } = setupQueryGuard()
    const gen1 = state.tryStart()
    // gen1 = 1, but end(999) will fail the generation check
    const result = state.end(999)
    expect(result).toBe(false)
    // State is still active — wrong-generation end does NOT clear
    expect(state.isActive).toBe(true)
    // Clean up with correct generation
    state.end(gen1!)
    teardown()
  })

  it('isActive reflects current state', () => {
    const { state, teardown } = setupQueryGuard()
    expect(state.isActive).toBe(false)
    const gen = state.tryStart()
    expect(state.isActive).toBe(true)
    state.end(gen!)
    expect(state.isActive).toBe(false)
    teardown()
  })

  it('teardown is idempotent', () => {
    const { teardown } = setupQueryGuard()
    teardown()
    expect(() => teardown()).not.toThrow()
  })

  it('getActiveOperation returns snapshot when active', () => {
    const { state, teardown } = setupQueryGuard()
    const gen = state.tryStart()
    const ops = state.getActiveOperation()
    // Returns empty snapshot object when no accessor plumbed
    expect(typeof ops).toBe('object')
    expect(ops).toHaveProperty('apiCalls')
    expect(ops).toHaveProperty('toolUses')
    state.end(gen!)
    teardown()
  })
})
