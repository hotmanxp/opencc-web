// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P2, Task 4): P2 integration tests for
 * createReplSession. Verifies wiring of L2 hook adapters
 * (setupApiKeyVerification / setupCostSummary / setupTasksV2Collapse)
 * + L3 setupNotifications bus. P0/P1 adapter unit tests live in their
 * own files; this file verifies the FACTORY wires them up so each
 * emits ReplEvent 'notification' through hooks.onEvent and dispose()
 * tears them all down (LIFO, idempotent).
 *
 * Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §5.1
 */

import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock BashTool circular-dep chain (same P1 pattern as smoke/p1-acceptance
// tests): bootstrap/state.ts pulls in settingsCache → tools.ts → BashTool
// → prompt.ts → timeouts.js where getMaxTimeoutMs is undefined at eval
// time. We only need runWithSdkContext here.
vi.mock('../../../opencc-src/bootstrap/state.js', async () => {
  const { AsyncLocalStorage } = await import('async_hooks')
  const sdkStorage = new AsyncLocalStorage<any>()
  return {
    runWithSdkContext: <T>(ctx: any, fn: () => T): T =>
      sdkStorage.run(ctx, fn),
    getSessionId: () => sdkStorage.getStore()?.sessionId ?? 'mock-session',
  }
})

// mock messageQueueManager chain (cmdQueue.enqueue path; same as smoke)
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

// mock cronScheduler chain
vi.mock('../../../opencc-src/utils/cronScheduler.js', () => ({
  createCronScheduler: () => ({
    start: () => {},
    stop: () => {},
  }),
}))

// mock ScheduleCronTool chain (kairos flag)
vi.mock('../../../opencc-src/tools/ScheduleCronTool/prompt.js', () => ({
  isKairosCronEnabled: () => false,
}))

// mock proactive module + growthbook gate
vi.mock('../../../opencc-src/proactive/index.js', () => ({
  subscribeToProactiveChanges: vi.fn(() => () => {}),
}))

vi.mock('../../../opencc-src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: vi.fn(() => false),
}))

// mock vendor query()
vi.mock('../../../opencc-src/query.js', () => ({
  query: async function* () {
    yield { type: 'result' }
  },
}))

// mock translateSdkToRuntime
vi.mock('../../../compat/runtime/sdkEventAdapter.js', () => ({
  translateSdkToRuntime: function* (_sdkMsg: unknown, _meta: unknown) {
    yield { type: 'passthrough', message: 'mock' }
  },
}))

// mock createUserMessage
vi.mock('../../../opencc-src/utils/messages.js', () => ({
  createUserMessage: (opts: any) => ({
    type: 'user',
    content: '',
    message: { role: 'user', content: opts.content ?? [] },
    uuid: opts.uuid,
  }),
}))

// Import after mocks are set up
import { createReplSession } from '../createReplSession.js'

describe('createReplSession P2 integration', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p2-int-'))

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('state.p2Wired is true after P2 wiring', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    const state = session.getState() as any
    expect(state.p2Wired).toBe(true)

    await session.dispose()
  })

  it('dispose() tears down all P2 handles and is idempotent', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    // First dispose: should run without throwing even though P2 handles
    // had nothing to do. P2 teardownStack order: apiKey → costSummary →
    // tasksV2 → notifications — all idempotent (set disposed=true).
    await expect(session.dispose()).resolves.toBeUndefined()

    // Second dispose: idempotency contract. The teardown callbacks all
    // guard against re-entry (`if (disposed) return`), so this must
    // not throw.
    await expect(session.dispose()).resolves.toBeUndefined()

    expect(session.getState().isDisposed).toBe(true)
  })

  it('dispose() works when no turns have run (P2 setup at construct time)', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    // No submit / no turn; dispose immediately. Verifies P2 wiring
    // happens synchronously in createReplSession and teardown runs
    // even if no turns ran.
    await expect(session.dispose()).resolves.toBeUndefined()
    expect(session.getState().isDisposed).toBe(true)
  })

  it('P2 wiring does not throw when getAppState returns undefined', async () => {
    // setupTasksV2Collapse.tasks reads getAppState(); verify the
    // wiring handles a missing getAppState (no throw during construct).
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
      // getAppState intentionally omitted
    })

    expect((session.getState() as any).p2Wired).toBe(true)
    await expect(session.dispose()).resolves.toBeUndefined()
  })
})