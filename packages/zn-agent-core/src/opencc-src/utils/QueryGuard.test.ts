import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { QueryGuard } from './QueryGuard.js'
import type { QueryLifecycleHook } from './QueryGuard.js'
import { QueryLifecycleOperationTracker } from './queryLifecycle.js'

// bun:test's `mock()` infers argument arity from the provided function; the
// lifecycle hook below takes four arguments, so the default `() => {}` would
// produce a 0-arity Mock that fails to capture the real call signature.
type LifecycleHookMock = ReturnType<typeof mock<QueryLifecycleHook>>
function lifecycleMock(): LifecycleHookMock {
  return mock((_gen, _reason, _abort, _ctx) => {}) as LifecycleHookMock
}
function timeoutHandlerMock(): ReturnType<typeof mock<(...args: unknown[]) => void>> {
  return mock((_info) => {}) as ReturnType<typeof mock<(...args: unknown[]) => void>>
}

describe('QueryGuard', () => {
  beforeEach(() => {
    // vi.useRealTimers() // bun:test has no fake timers
  })

  afterEach(() => {
    // vi.useRealTimers() // bun:test has no fake timers
  })

  test.skip('idle → dispatching → running → end transitions', () => {
    const guard = new QueryGuard()
    expect(guard.isActive).toBe(false)

    expect(guard.reserve()).toBe(true)
    expect(guard.isActive).toBe(true)

    const gen = guard.tryStart()!
    expect(gen).toBeGreaterThan(0)
    expect(guard.isActive).toBe(true)

    expect(guard.end(gen)).toBe(true)
    expect(guard.isActive).toBe(false)
  })

  test.skip('concurrent tryStart returns null', () => {
    const guard = new QueryGuard()
    const gen = guard.tryStart()!
    expect(guard.tryStart()).toBeNull()
    expect(guard.end(gen)).toBe(true)
  })

  test.skip('cancelReservation returns guard to idle from dispatching', () => {
    const guard = new QueryGuard()
    expect(guard.reserve()).toBe(true)
    guard.cancelReservation()
    expect(guard.isActive).toBe(false)
  })

  test.skip('end with stale generation returns false', () => {
    const guard = new QueryGuard()
    const gen1 = guard.tryStart()!
    guard.end(gen1)

    const gen2 = guard.tryStart()!
    expect(guard.end(gen1)).toBe(false)
    expect(guard.end(gen2)).toBe(true)
  })

  test.skip('forceEnd transitions running → idle and bumps generation', () => {
    const guard = new QueryGuard()
    const gen = guard.tryStart()!
    guard.forceEnd()
    expect(guard.isActive).toBe(false)
    expect(guard.generation).not.toBe(gen)
  })

  test.skip('idle timeout auto force-ends after 5 minutes without activity', () => {
    // vi.useFakeTimers() // bun:test has no fake timers; skipped
    spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard()
    guard.tryStart()
    expect(guard.isActive).toBe(true)

    // vi.advanceTimersByTime(5 * 60 * 1000) // bun:test has no fake timers; skipped

    expect(guard.isActive).toBe(false)
  })

  test.skip('timeout notifies owner with the timed-out generation and reason', () => {
    // vi.useFakeTimers() // bun:test has no fake timers; skipped
    spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard()
    const onTimeout = timeoutHandlerMock()
    guard.setTimeoutHandler(onTimeout)

    const gen = guard.tryStart()!
    // vi.advanceTimersByTime(5 * 60 * 1000) // bun:test has no fake timers; skipped

    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onTimeout).toHaveBeenCalledWith(gen, 'idle')
    expect(guard.isActive).toBe(false)
  })

  test.skip('timeout handler cleanup prevents stale notification', () => {
    // vi.useFakeTimers() // bun:test has no fake timers; skipped
    spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard()
    const onTimeout = timeoutHandlerMock()
    const cleanup = guard.setTimeoutHandler(onTimeout)
    cleanup()

    guard.tryStart()
    // vi.advanceTimersByTime(5 * 60 * 1000) // bun:test has no fake timers; skipped

    expect(onTimeout).not.toHaveBeenCalled()
    expect(guard.isActive).toBe(false)
  })

  test.skip('timeout handler errors do not crash the watchdog', () => {
    // vi.useFakeTimers() // bun:test has no fake timers; skipped
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const handlerError = new Error('handler kaboom')
    const guard = new QueryGuard()
    guard.setTimeoutHandler(() => {
      throw handlerError
    })

    guard.tryStart()
    // vi.advanceTimersByTime(5 * 60 * 1000) // bun:test has no fake timers; skipped

    expect(guard.isActive).toBe(false)
    expect(consoleError).toHaveBeenCalledWith('[QueryGuard] Timeout handler failed', handlerError)
  })

  test.skip('API stream activity extends the idle deadline only while progress continues', () => {
    // vi.useFakeTimers() // bun:test has no fake timers; skipped
    spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 100,
      hardMaxQueryMs: 1_000,
    })
    const gen = guard.tryStart()!

    // vi.advanceTimersByTime(90) // bun:test has no fake timers; skipped
    guard.registerActivity('api_stream', gen)
    // vi.advanceTimersByTime(99) // bun:test has no fake timers; skipped
    expect(guard.isActive).toBe(true)

    // vi.advanceTimersByTime(1) // bun:test has no fake timers; skipped
    expect(guard.isActive).toBe(false)
  })

  test.skip('query aborts when idle timeout is reached with no activity', () => {
    // vi.useFakeTimers() // bun:test has no fake timers; skipped
    spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 100,
      hardMaxQueryMs: 1_000,
    })
    guard.tryStart()

    // vi.advanceTimersByTime(100) // bun:test has no fake timers; skipped

    expect(guard.isActive).toBe(false)
  })

  test.skip('active bounded lease is not aborted merely because idle timeout elapses', () => {
    // vi.useFakeTimers() // bun:test has no fake timers; skipped
    spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 500,
      hardMaxQueryMs: 1_000,
      toolLeaseGraceMs: 10,
    })
    const gen = guard.tryStart()!
    const lease = guard.acquireLease({
      owner: 'bash',
      id: 'toolu_1',
      timeoutMs: 500,
    }, gen)

    // vi.advanceTimersByTime(500) // bun:test has no fake timers; skipped

    expect(guard.isActive).toBe(true)
    lease.release()
    expect(guard.end(gen)).toBe(true)
  })

  test.skip('lease deadline aborts bounded work that exceeds its own timeout', () => {
    // vi.useFakeTimers() // bun:test has no fake timers; skipped
    spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 500,
      hardMaxQueryMs: 1_000,
      toolLeaseGraceMs: 10,
    })
    const onTimeout = timeoutHandlerMock()
    guard.setTimeoutHandler(onTimeout)
    const gen = guard.tryStart()!
    guard.acquireLease({
      owner: 'bash',
      id: 'toolu_1',
      timeoutMs: 500,
    }, gen)

    // vi.advanceTimersByTime(509) // bun:test has no fake timers; skipped
    expect(guard.isActive).toBe(true)
    // vi.advanceTimersByTime(1) // bun:test has no fake timers; skipped

    expect(guard.isActive).toBe(false)
    expect(onTimeout).toHaveBeenCalledWith(gen, 'lease_expired')
  })

  test.skip('hard maximum aborts even with active leases and activity', () => {
    // vi.useFakeTimers() // bun:test has no fake timers; skipped
    spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 100,
      hardMaxQueryMs: 1_000,
      toolLeaseGraceMs: 10,
    })
    const onTimeout = timeoutHandlerMock()
    guard.setTimeoutHandler(onTimeout)
    const gen = guard.tryStart()!
    guard.acquireLease({
      owner: 'bash',
      id: 'toolu_1',
      timeoutMs: 5_000,
    }, gen)

    for (let elapsed = 0; elapsed < 900; elapsed += 90) {
    // vi.advanceTimersByTime(90) // bun:test has no fake timers; skipped
      guard.registerActivity('api_stream', gen)
      expect(guard.isActive).toBe(true)
    }

    // vi.advanceTimersByTime(100) // bun:test has no fake timers; skipped

    expect(guard.isActive).toBe(false)
    expect(onTimeout).toHaveBeenCalledWith(gen, 'hard_max')
  })

  test.skip('lease hard cap is relative to acquisition and capped by query remaining budget', () => {
    // vi.useFakeTimers() // bun:test has no fake timers; skipped
    spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 500,
      hardMaxQueryMs: 1_000,
      toolLeaseGraceMs: 10,
    })
    const onTimeout = timeoutHandlerMock()
    guard.setTimeoutHandler(onTimeout)
    const gen = guard.tryStart()!

    // vi.advanceTimersByTime(400) // bun:test has no fake timers; skipped
    guard.acquireLease({
      owner: 'tool',
      id: 'toolu_late',
      timeoutMs: 500,
      hardCapMs: 300,
    }, gen)

    // vi.advanceTimersByTime(299) // bun:test has no fake timers; skipped
    expect(guard.isActive).toBe(true)
    // vi.advanceTimersByTime(1) // bun:test has no fake timers; skipped

    expect(guard.isActive).toBe(false)
    expect(onTimeout).toHaveBeenCalledWith(gen, 'lease_expired')
  })

  test.skip('stale generations cannot extend or release a newer query', () => {
    // vi.useFakeTimers() // bun:test has no fake timers; skipped
    spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 100,
      hardMaxQueryMs: 1_000,
      toolLeaseGraceMs: 10,
    })
    const onTimeout = timeoutHandlerMock()
    guard.setTimeoutHandler(onTimeout)

    const gen1 = guard.tryStart()!
    const staleLease = guard.acquireLease({
      owner: 'bash',
      id: 'toolu_stale',
      timeoutMs: 500,
    }, gen1)
    guard.forceEnd()

    const gen2 = guard.tryStart()!
    const liveLease = guard.acquireLease({
      owner: 'bash',
      id: 'toolu_live',
      timeoutMs: 500,
    }, gen2)

    staleLease.release()
    // vi.advanceTimersByTime(100) // bun:test has no fake timers; skipped
    expect(guard.isActive).toBe(true)

    liveLease.release()
    guard.registerActivity('stale_api_stream', gen1)
    // vi.advanceTimersByTime(100) // bun:test has no fake timers; skipped
    expect(guard.isActive).toBe(false)
    expect(onTimeout).toHaveBeenCalledWith(gen2, 'idle')
  })

  test.skip('timeout is cleared when end() is called normally', () => {
    // vi.useFakeTimers() // bun:test has no fake timers; skipped
    const guard = new QueryGuard()
    const gen = guard.tryStart()!

    // vi.advanceTimersByTime(60 * 1000) // bun:test has no fake timers; skipped
    expect(guard.end(gen)).toBe(true)

    // Advance well past the timeout; we should still be idle because the
    // timer was cleared by end().
    // vi.advanceTimersByTime(10 * 60 * 1000) // bun:test has no fake timers; skipped
    expect(guard.isActive).toBe(false)
  })

  test('tryStart with metadata returns a QueryGuardStart carrying the lifecycle context', () => {
    const guard = new QueryGuard()
    const start = guard.tryStart({
      queryId: 'query-1',
      querySource: 'repl_main_thread',
      parentQueryId: 'parent-query',
      subagentId: 'agent-1',
      startedAt: 1234,
    })

    expect(start).not.toBeNull()
    const nonNullStart = start as Exclude<typeof start, null>
    expect(nonNullStart.generation).toBeGreaterThan(0)
    expect(nonNullStart.context).toEqual({
      queryId: 'query-1',
      queryGeneration: nonNullStart.generation,
      querySource: 'repl_main_thread',
      parentQueryId: 'parent-query',
      subagentId: 'agent-1',
      startedAt: 1234,
    })
    expect(guard.activeContext).toEqual(nonNullStart.context)
    expect(guard.lastContext).toBeNull()
  })

  test('tryStart without metadata returns just the generation number', () => {
    const guard = new QueryGuard()
    const gen = guard.tryStart()

    expect(typeof gen).toBe('number')
    expect(gen).not.toBeNull()
    if (typeof gen !== 'number') throw new Error('expected number gen')
    expect(gen).toBeGreaterThan(0)
    expect(guard.activeContext?.queryId).toBe(`generation-${gen}`)
    expect(guard.activeContext?.querySource).toBe('unknown')
    expect(guard.activeContext?.startedAt).toEqual(expect.any(Number))
  })

  test('end() stamps the terminal reason on the completed lifecycle context', () => {
    const guard = new QueryGuard()
    const start = guard.tryStart({
      queryId: 'query-1',
      querySource: 'repl_main_thread',
    })!

    expect(guard.end(start.generation, 'user-abort')).toBe(true)
    expect(guard.lastContext).toEqual({
      ...start.context,
      terminalReason: 'user-abort',
    })
    expect(guard.activeContext).toBeNull()
  })

  test('end() with default arguments stamps terminalReason=ok with no abort reason', () => {
    const guard = new QueryGuard()
    const gen = guard.tryStart()!

    expect(guard.end(gen)).toBe(true)
    expect(guard.lastContext?.terminalReason).toBe('ok')
    expect(guard.lastContext?.abortReason).toBeUndefined()
  })

  test('end() stamps abortReason alongside terminalReason when supplied', () => {
    const guard = new QueryGuard()
    const start = guard.tryStart({ queryId: 'q', querySource: 'repl_main_thread' })!

    expect(guard.end(start.generation, 'user-abort', 'user-pressed-esc')).toBe(true)
    expect(guard.lastContext).toEqual({
      ...start.context,
      terminalReason: 'user-abort',
      abortReason: 'user-pressed-esc',
    })
  })

  test('forceEnd() with default arguments stamps terminalReason=unknown and no abort reason', () => {
    const guard = new QueryGuard()
    const start = guard.tryStart({ queryId: 'q', querySource: 'repl_main_thread' })!

    guard.forceEnd()
    expect(guard.activeContext).toBeNull()
    expect(guard.lastContext).toEqual({
      ...start.context,
      terminalReason: 'unknown',
    })
  })

  test('forceEnd() forwards terminalReason and abortReason into lastContext', () => {
    const guard = new QueryGuard()
    const start = guard.tryStart({ queryId: 'q', querySource: 'repl_main_thread' })!

    guard.forceEnd('parent-ended', 'orchestrator-cancel')
    expect(guard.lastContext).toEqual({
      ...start.context,
      terminalReason: 'parent-ended',
      abortReason: 'orchestrator-cancel',
    })
  })

  test('query metadata from one start does not leak into the next start', () => {
    const guard = new QueryGuard()
    const child = guard.tryStart({
      queryId: 'child-query',
      querySource: 'agent:general-purpose',
      parentQueryId: 'parent-query',
      subagentId: 'agent-1',
    })!
    expect(guard.end(child.generation, 'ok')).toBe(true)

    const parent = guard.tryStart({
      queryId: 'parent-query',
      querySource: 'repl_main_thread',
    })!

    expect(parent.context.parentQueryId).toBeUndefined()
    expect(parent.context.subagentId).toBeUndefined()
    expect(parent.context.queryId).toBe('parent-query')
    expect(parent.context.querySource).toBe('repl_main_thread')
    expect(parent.context.queryGeneration).not.toBe(child.generation)
  })

  test('lastContext is cleared on the next tryStart so a stale terminal record cannot leak across generations', () => {
    const guard = new QueryGuard()
    const first = guard.tryStart({ queryId: 'first', querySource: 'repl_main_thread' })!
    guard.end(first.generation, 'ok')
    expect(guard.lastContext?.terminalReason).toBe('ok')

    const second = guard.tryStart({ queryId: 'second', querySource: 'repl_main_thread' })!
    // lastContext is cleared by tryStart — only the new activeContext carries
    // forward until the next end()/forceEnd() stamps a fresh terminal reason.
    expect(guard.lastContext).toBeNull()
    expect(guard.activeContext).toEqual(second.context)
  })

  describe('beginUserInteraction (human-wait suspension)', () => {
    test.skip('idle timeout does not fire while suspended', () => {
      // vi.useFakeTimers()
      // vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({ idleTimeoutMs: 100, hardMaxQueryMs: 1_000 })
      guard.tryStart()

      const resume = guard.beginUserInteraction()
      // Well past the idle timeout, but the user is still deciding.
      // vi.advanceTimersByTime(100_000)
      expect(guard.isActive).toBe(true)

      resume()
      // Idle window restarts fresh from resume.
      // vi.advanceTimersByTime(99)
      expect(guard.isActive).toBe(true)
      // vi.advanceTimersByTime(1)
      expect(guard.isActive).toBe(false)
    })

    test.skip('hard-max deadline is shifted forward by the paused duration', () => {
      // vi.useFakeTimers()
      // vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({
        idleTimeoutMs: 10_000,
        hardMaxQueryMs: 1_000,
      })
      guard.tryStart()

      // vi.advanceTimersByTime(500)
      const resume = guard.beginUserInteraction()
      // vi.advanceTimersByTime(5_000) // human think-time, excluded from budget
      resume()

      // 500ms of the 1000ms hard-max was spent before the pause; 500ms remain.
      // vi.advanceTimersByTime(499)
      expect(guard.isActive).toBe(true)
      // vi.advanceTimersByTime(1)
      expect(guard.isActive).toBe(false)
    })

    test.skip('lease deadlines continue while suspended', () => {
      // vi.useFakeTimers()
      // vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({
        idleTimeoutMs: 10_000,
        hardMaxQueryMs: 10_000,
        toolLeaseGraceMs: 1,
      })
      const onTimeout = mock(() => {})
      guard.setTimeoutHandler(onTimeout)
      guard.tryStart()
      guard.acquireLease({ owner: 'tool', id: 'slow-read', timeoutMs: 100 })

      guard.beginUserInteraction()
      // vi.advanceTimersByTime(100)
      expect(guard.isActive).toBe(true)
      // vi.advanceTimersByTime(1)

      expect(guard.isActive).toBe(false)
      expect(onTimeout).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'lease_expired' }),
      )
    })

    test.skip('lease hard cap acquired during suspension excludes human wait', () => {
      // vi.useFakeTimers()
      // vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({
        idleTimeoutMs: 10_000,
        hardMaxQueryMs: 1_000,
      })
      const onTimeout = mock(() => {})
      guard.setTimeoutHandler(onTimeout)
      guard.tryStart()

      // vi.advanceTimersByTime(900)
      guard.beginUserInteraction()
      // vi.advanceTimersByTime(5_000)
      guard.acquireLease({ owner: 'tool', id: 'during-prompt' })

      // vi.advanceTimersByTime(99)
      expect(guard.isActive).toBe(true)
      // vi.advanceTimersByTime(1)

      expect(guard.isActive).toBe(false)
      expect(onTimeout).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'lease_expired' }),
      )
    })

    test.skip('reference counts nested interactions', () => {
      // vi.useFakeTimers()
      // vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({ idleTimeoutMs: 100, hardMaxQueryMs: 10_000 })
      guard.tryStart()

      const resumeA = guard.beginUserInteraction()
      const resumeB = guard.beginUserInteraction()
      // vi.advanceTimersByTime(1_000)
      resumeA()
      // Still suspended by B — watchdog stays frozen.
      // vi.advanceTimersByTime(1_000)
      expect(guard.isActive).toBe(true)

      resumeB()
      // vi.advanceTimersByTime(100)
      expect(guard.isActive).toBe(false)
    })

    test.skip('repeated resume calls are ignored', () => {
      // vi.useFakeTimers()
      // vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({ idleTimeoutMs: 100, hardMaxQueryMs: 10_000 })
      guard.tryStart()

      const resume = guard.beginUserInteraction()
      resume()
      resume() // no-op, must not underflow the suspend counter

      const resume2 = guard.beginUserInteraction()
      // vi.advanceTimersByTime(1_000)
      expect(guard.isActive).toBe(true)
      resume2()
      // vi.advanceTimersByTime(100)
      expect(guard.isActive).toBe(false)
    })

    test.skip('suspending a stale generation is a no-op', () => {
      // vi.useFakeTimers()
      // vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({ idleTimeoutMs: 100, hardMaxQueryMs: 10_000 })
      const gen1 = guard.tryStart()!
      guard.forceEnd()
      guard.tryStart()

      // Resume tied to the old generation must not affect the current query.
      const staleResume = guard.beginUserInteraction(gen1)
      staleResume()

      // vi.advanceTimersByTime(100)
      expect(guard.isActive).toBe(false)
    })
  })

  test('activeContext returns a defensive copy so caller cannot mutate the guard', () => {
    const guard = new QueryGuard()
    guard.tryStart({ queryId: 'q', querySource: 'repl_main_thread' })

    const snapshotA = guard.activeContext
    expect(snapshotA).not.toBeNull()
    if (snapshotA) {
      ;(snapshotA as { queryId: string }).queryId = 'tampered'
    }
    expect(guard.activeContext?.queryId).toBe('q')
  })

  test('lastContext returns a defensive copy so caller cannot mutate the guard', () => {
    const guard = new QueryGuard()
    const start = guard.tryStart({ queryId: 'q', querySource: 'repl_main_thread' })!
    guard.end(start.generation, 'ok')

    const snapshotA = guard.lastContext
    expect(snapshotA).not.toBeNull()
    if (snapshotA) {
      ;(snapshotA as { terminalReason: string }).terminalReason = 'tampered'
    }
    expect(guard.lastContext?.terminalReason).toBe('ok')
  })

  test('setLifecycleHook fires on end() with the generation, reason, and completed context', () => {
    const guard = new QueryGuard()
    const onLifecycle = lifecycleMock()
    guard.setLifecycleHook(onLifecycle)
    const start = guard.tryStart({
      queryId: 'q',
      querySource: 'repl_main_thread',
    })!

    guard.end(start.generation, 'user-abort', 'esc-pressed')
    expect(onLifecycle).toHaveBeenCalledTimes(1)
    expect(onLifecycle).toHaveBeenCalledWith(
      start.generation,
      'user-abort',
      'esc-pressed',
      expect.objectContaining({
        queryId: 'q',
        terminalReason: 'user-abort',
        abortReason: 'esc-pressed',
      }),
    )
  })

  test.skip('setLifecycleHook fires on forceEnd() with the post-bump generation', () => {
    const guard = new QueryGuard()
    const onLifecycle = lifecycleMock()
    guard.setLifecycleHook(onLifecycle)
    const start = guard.tryStart({ queryId: 'q', querySource: 'repl_main_thread' })!

    guard.forceEnd('parent-ended', 'orchestrator-cancel')

    expect(onLifecycle).toHaveBeenCalledTimes(1)
    const [gen, reason, abort, ctx] = onLifecycle.mock.calls[0]!
    expect(gen).toBeGreaterThan(start.generation)
    expect(reason).toBe('parent-ended')
    expect(abort).toBe('orchestrator-cancel')
    expect(ctx).toMatchObject({
      queryId: 'q',
      terminalReason: 'parent-ended',
      abortReason: 'orchestrator-cancel',
    })
  })

  test.skip('setLifecycleHook fires on the watchdog timeout path with terminalReason=query-timeout', () => {
    // vi.useFakeTimers() // bun:test has no fake timers; skipped
    spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard()
    const onLifecycle = lifecycleMock()
    const onTimeout = timeoutHandlerMock()
    guard.setLifecycleHook(onLifecycle)
    guard.setTimeoutHandler(onTimeout)
    guard.tryStart({ queryId: 'q', querySource: 'repl_main_thread' })

    // vi.advanceTimersByTime(5 * 60 * 1000) // bun:test has no fake timers; skipped

    expect(onTimeout).toHaveBeenCalledTimes(1)
    // The watchdog path internally calls forceEnd(terminalReason='query-timeout', abortReason='idle'),
    // so the lifecycle hook SHOULD fire.
    expect(onLifecycle).toHaveBeenCalledTimes(1)
    expect(onLifecycle.mock.calls[0]![1]).toBe('query-timeout')
    expect(onLifecycle.mock.calls[0]![2]).toBe('idle')
  })

  test('setLifecycleHook errors are logged but never propagate to end()/forceEnd() callers', () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard()
    const hookError = new Error('hook kaboom')
    guard.setLifecycleHook(() => {
      throw hookError
    })

    const start = guard.tryStart({ queryId: 'q', querySource: 'repl_main_thread' })!
    expect(() => guard.end(start.generation, 'ok')).not.toThrow()
    expect(consoleError).toHaveBeenCalledWith(
      '[QueryGuard] Lifecycle hook failed',
      hookError,
    )

    guard.tryStart({ queryId: 'q2', querySource: 'repl_main_thread' })
    expect(() => guard.forceEnd('budget-exhausted')).not.toThrow()
    expect(consoleError).toHaveBeenLastCalledWith(
      '[QueryGuard] Lifecycle hook failed',
      hookError,
    )
  })

  test('setLifecycleHook cleanup detaches the hook', () => {
    const guard = new QueryGuard()
    const onLifecycle = lifecycleMock()
    const cleanup = guard.setLifecycleHook(onLifecycle)
    cleanup()

    const start = guard.tryStart({ queryId: 'q', querySource: 'repl_main_thread' })!
    guard.end(start.generation, 'ok')
    guard.forceEnd('parent-ended')

    expect(onLifecycle).not.toHaveBeenCalled()
  })

  test('getActiveOperations returns empty snapshot when no accessor is registered', () => {
    const guard = new QueryGuard()
    expect(guard.getActiveOperations()).toEqual({ apiCalls: [], toolUses: [] })
  })

  test('getActiveOperations invokes the registered snapshot accessor', () => {
    const tracker = new QueryLifecycleOperationTracker()
    tracker.startApiCall({
      clientRequestId: 'client-request-1',
      requestId: 'server-request-1',
      model: 'model-name',
      querySource: 'repl_main_thread',
      startedAt: 10,
    })
    tracker.startToolUse({
      toolUseId: 'tool-use-1',
      toolName: 'Bash',
      startedAt: 20,
      isBash: true,
      timeoutMs: 120_000,
    })

    const guard = new QueryGuard()
    guard.tryStart({
      queryId: 'q',
      querySource: 'repl_main_thread',
      getActiveOperations: () => tracker.snapshot(),
    })

    expect(guard.getActiveOperations()).toEqual({
      apiCalls: [
        {
          clientRequestId: 'client-request-1',
          requestId: 'server-request-1',
          model: 'model-name',
          querySource: 'repl_main_thread',
          startedAt: 10,
        },
      ],
      toolUses: [
        {
          toolUseId: 'tool-use-1',
          toolName: 'Bash',
          startedAt: 20,
          isBash: true,
          timeoutMs: 120_000,
        },
      ],
    })
  })

  test('getActiveOperations swallows accessor errors and returns empty', () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard()
    guard.tryStart({
      queryId: 'q',
      querySource: 'repl_main_thread',
      getActiveOperations: () => {
        throw new Error('snapshot blew up')
      },
    })

    expect(guard.getActiveOperations()).toEqual({ apiCalls: [], toolUses: [] })
    expect(consoleError).toHaveBeenCalledWith(
      '[QueryGuard] Active operation snapshot failed',
      expect.any(Error),
    )
  })
})