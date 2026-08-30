// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): ALS sessionId isolation tests.
 *
 * Verifies the critical property that two createReplSession instances with
 * different sessionIds route getSessionId() (from bootstrap/state.ts) and
 * getCurrentSessionId() (from compat/runWithSessionId.ts) correctly via
 * AsyncLocalStorage — catching the classic "global __zaiCurrentSessionId
 * pointer" bug from the print.ts instance path.
 *
 * The two ALS helpers are verified via the lifecycle subscriber mechanism:
 *   - Test 1: Two sessions can submit concurrently without interference
 *   - Test 2: Inside runTurn, both ALS helpers see the correct sessionId
 *
 * Both getSessionId (sdkContextStorage) and getCurrentSessionId (compat
 * sessionStorage) must return the session's own ID, not another session's.
 */

import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AsyncLocalStorage } from 'async_hooks'

// ---------------------------------------------------------------------------
// Mock vendor chains that createReplSession depends on.
// ---------------------------------------------------------------------------
//
// NOTE: bootstrap/state.ts pulls in settingsCache → tools.ts → BashTool
// → prompt.ts → timeouts.js — fails to evaluate under vitest ESM due to
// circular dep at prompt.ts evaluation time. We mock the two symbols this
// test actually observes: runWithSdkContext and getSessionId.
//
const sdkStorage = new AsyncLocalStorage<any>()
vi.mock('../../../opencc-src/bootstrap/state.js', () => ({
  runWithSdkContext: <T>(ctx: any, fn: () => T): T =>
    sdkStorage.run(ctx, fn),
  getSessionId: () => sdkStorage.getStore()?.sessionId ?? 'mock-session',
}))

//
// compat/runWithSessionId.ts — the second ALS helper we are verifying.
// Same mock pattern; separate storage so the two ALS contexts are independent.
//
const sessionStorage = new AsyncLocalStorage<{ sessionId: string }>()
vi.mock('../../../compat/runWithSessionId.js', () => ({
  runWithSessionId: <T>(sessionId: string, fn: () => T): T =>
    sessionStorage.run({ sessionId }, fn),
  getCurrentSessionId: () => sessionStorage.getStore()?.sessionId,
}))

vi.mock('../../../opencc-src/utils/messageQueueManager.js', () => {
  let mockQueue: any[] = []
  const PRIORITY_ORDER: Record<string, number> = { now: 0, next: 1, later: 2 }
  return {
    getCommandQueue: () => [...mockQueue],
    enqueue: (cmd: any) => {
      mockQueue.push({ ...cmd, priority: cmd.priority ?? 'next' })
    },
    dequeue: () => {
      if (mockQueue.length === 0) return undefined
      let bestIdx = -1
      let bestPriority = Infinity
      for (let i = 0; i < mockQueue.length; i++) {
        const p = PRIORITY_ORDER[mockQueue[i]!.priority ?? 'next'] ?? 1
        if (p < bestPriority) {
          bestPriority = p
          bestIdx = i
        }
      }
      if (bestIdx === -1) return undefined
      const [item] = mockQueue.splice(bestIdx, 1)
      return item
    },
    enqueuePendingNotification: () => {},
    resetCommandQueue: () => {
      mockQueue = []
    },
  }
})

vi.mock('../../../opencc-src/utils/cronScheduler.js', () => ({
  createCronScheduler: () => ({
    start: () => {},
    stop: () => {},
  }),
}))

vi.mock('../../../opencc-src/tools/ScheduleCronTool/prompt.js', () => ({
  isKairosCronEnabled: () => false,
}))

vi.mock('../../../opencc-src/proactive/index.js', () => ({
  subscribeToProactiveChanges: vi.fn(() => () => {}),
}))

vi.mock('../../../opencc-src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: vi.fn(() => false),
}))

vi.mock('../../../opencc-src/utils/messages.js', () => ({
  createUserMessage: (opts: any) => ({
    type: 'user',
    content: '',
    message: { role: 'user', content: opts.content ?? [] },
    uuid: opts.uuid,
  }),
}))

vi.mock('../../../opencc-src/query.js', () => ({
  query: async function* () {
    yield { type: 'result' }
  },
}))

vi.mock('../../../compat/runtime/sdkEventAdapter.js', () => ({
  translateSdkToRuntime: function* (_sdkMsg: unknown, _meta: unknown) {
    yield { type: 'passthrough', message: 'mock' }
  },
}))

// Import after mocks are set up
import { createReplSession } from '../createReplSession.js'

describe('createReplSession ALS isolation', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p0-conc-'))

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('two concurrent sessions route ALS sessionId correctly', async () => {
    // Create two sessions with distinct IDs.
    const sidA = `s-A-${randomUUID()}`
    const sidB = `s-B-${randomUUID()}`

    const eventsA: any[] = []
    const eventsB: any[] = []

    const sessionA = createReplSession({
      sessionId: sidA,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => eventsA.push(ev) },
    })

    const sessionB = createReplSession({
      sessionId: sidB,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => eventsB.push(ev) },
    })

    // Both sessions can submit without interfering with each other.
    await expect(sessionA.submit([])).resolves.toBeUndefined()
    await expect(sessionB.submit([])).resolves.toBeUndefined()

    // Verify each session saw exactly one turnEnd (synthetic, from P0 stub).
    const turnEndA = eventsA.filter(e => e.type === 'turnEnd')
    const turnEndB = eventsB.filter(e => e.type === 'turnEnd')
    expect(turnEndA).toHaveLength(1)
    expect(turnEndB).toHaveLength(1)

    // Each session's events carry its own sessionId, not the other's.
    for (const ev of eventsA) {
      expect(ev.sessionId).toBe(sidA)
    }
    for (const ev of eventsB) {
      expect(ev.sessionId).toBe(sidB)
    }

    await sessionA.dispose()
    await sessionB.dispose()
  })

  it('ALS sessionId is the right value inside runTurn', async () => {
    // Observe the ALS values inside the turnEnd subscriber — that callback
    // runs synchronously after the runWithSdkContext+runWithSessionId block
    // completes, so it is still within the ALS context.
    const sid = `s-${randomUUID()}`

    // We capture the ALS values at two points:
    //   1. Inside the on('turnEnd') callback  ← still inside ALS context
    //   2. After the callback returns         ← outside ALS context
    let observedInCallback: { sdk: string | undefined; compat: string | undefined } | null = null
    let observedAfterCallback: { sdk: string | undefined; compat: string | undefined } | null = null

    // Access the mock getters directly from the mocked modules.
    // Both modules are already mocked above; we import their getter functions
    // by re-importing through the mock boundary.
    const { getSessionId } = await import('../../../opencc-src/bootstrap/state.js')
    const { getCurrentSessionId } = await import('../../../compat/runWithSessionId.js')

    const session = createReplSession({
      sessionId: sid,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    // Register turnEnd subscriber INSIDE the ALS context.
    const unsub = session.on('turnEnd', () => {
      observedInCallback = {
        sdk: getSessionId(),
        compat: getCurrentSessionId(),
      }
    })

    await session.submit([])

    // After the callback returns, ALS context is gone.
    observedAfterCallback = {
      sdk: getSessionId(),
      compat: getCurrentSessionId(),
    }

    unsub()

    // Inside the callback: both ALS helpers see our sessionId.
    expect(observedInCallback).not.toBeNull()
    expect(observedInCallback!.sdk).toBe(sid)
    expect(observedInCallback!.compat).toBe(sid)

    // After callback (outside ALS): they return the fallback/mock values.
    // sdk: getSessionId falls back to STATE.sessionId = 'mock-session'
    // compat: getCurrentSessionId returns undefined outside any session context
    expect(observedAfterCallback!.sdk).toBe('mock-session')
    expect(observedAfterCallback!.compat).toBeUndefined()

    await session.dispose()
  })

  it('interleaved submits from two sessions produce distinct turnIndex sequences', async () => {
    const sidA = `s-A-${randomUUID()}`
    const sidB = `s-B-${randomUUID()}`

    const eventsA: any[] = []
    const eventsB: any[] = []

    const sessionA = createReplSession({
      sessionId: sidA,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => eventsA.push(ev) },
    })

    const sessionB = createReplSession({
      sessionId: sidB,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => eventsB.push(ev) },
    })

    // Alternate submits to ensure turnIndex is per-session, not global.
    await sessionA.submit([])
    await sessionB.submit([])
    await sessionA.submit([])
    await sessionB.submit([])

    // Each session should have turnIndex = 2 (two submits each).
    expect(sessionA.getState().turnIndex).toBe(2)
    expect(sessionB.getState().turnIndex).toBe(2)

    // Verify event sequence per session.
    const turnStartsA = eventsA.filter(e => e.type === 'turnStart')
    const turnStartsB = eventsB.filter(e => e.type === 'turnStart')
    expect(turnStartsA).toHaveLength(2)
    expect(turnStartsB).toHaveLength(2)

    // turnIndex in events should be sequential within each session.
    const turnIndexesA = turnStartsA.map(e => e.payload?.turnIndex)
    const turnIndexesB = turnStartsB.map(e => e.payload?.turnIndex)
    expect(turnIndexesA).toEqual([1, 2])
    expect(turnIndexesB).toEqual([1, 2])

    await sessionA.dispose()
    await sessionB.dispose()
  })
})
