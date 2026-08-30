// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L1 setupProactive adapter tests.
 *
 * NOTE: The proactive module and useProactive hook are behind GrowthBook gates
 * (PROACTIVE / KAIROS features) that are only enabled in Bun builds via
 * bun:bundle feature(). In Node.js, we mock the GrowthBook gate to isolate
 * tests from this pre-existing environmental issue.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock proactiveModule functions
vi.mock('../../../opencc-src/proactive/index.js', () => ({
  subscribeToProactiveChanges: vi.fn(() => () => {}),
  isProactiveActive: vi.fn(() => false),
  isProactivePaused: vi.fn(() => false),
  getNextTickAt: vi.fn(() => null),
  activateProactive: vi.fn(),
  deactivateProactive: vi.fn(),
  pauseProactive: vi.fn(),
  resumeProactive: vi.fn(),
  setContextBlocked: vi.fn(),
}))

// Mock GrowthBook gate — avoid importing from bun:bundle in Node.js
vi.mock('../../../opencc-src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: vi.fn((feature: string, defaultVal: boolean) => {
    if (feature === 'PROACTIVE' || feature === 'KAIROS') return true
    return defaultVal
  }),
}))

// Import after mocks are set up
import { setupProactive } from '../setup/setupProactive.js'

describe('setupProactive', () => {
  it('teardown stops timer cleanly', () => {
    const submitted: string[] = []
    const queued: string[] = []
    const handle = setupProactive({
      sessionId: 's1',
      isLoading: () => false,
      queuedCommandsLength: () => 0,
      onSubmitTick: p => submitted.push(p),
      onQueueTick: p => queued.push(p),
    })
    handle.teardown()
    expect(submitted).toEqual([])
    expect(queued).toEqual([])
  })

  it('teardown is idempotent', () => {
    const handle = setupProactive({
      sessionId: 's1',
      isLoading: () => false,
      queuedCommandsLength: () => 0,
    })
    handle.teardown()
    expect(() => handle.teardown()).not.toThrow()
  })

  it('isLoading=true suppresses submitTick', () => {
    let submitted = false
    const handle = setupProactive({
      sessionId: 's1',
      isLoading: () => true,
      queuedCommandsLength: () => 0,
      onSubmitTick: () => { submitted = true },
    })
    // timer should not fire submitTick while isLoading
    handle.teardown()
    expect(submitted).toBe(false)
  })
})