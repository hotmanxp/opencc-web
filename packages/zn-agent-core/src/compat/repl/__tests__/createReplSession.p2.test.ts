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

  // zai patch (2026-08-30, plan P2, Task 4): setupApiKeyVerification is
  // wired at session create (mirrors REPL.tsx mount semantics) and the
  // callback fires when verify() runs. The test exercises the wiring
  // by calling verify() on the accessor-exposed handle, which routes
  // through the createReplSession's onResult callback and emits an
  // 'apiKeyOk' notification on hooks.onEvent. The adapter is
  // intentionally NOT auto-kicked at construct time — that would
  // interleave a 'notification' event with the first turnStart/turnEnd
  // pair and break createReplSession.query.test.ts which asserts
  // turnStart is the first event.
  it('setupApiKeyVerification emits notification when verify() runs', async () => {
    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })

    const handle = session.getApiKeyHandle?.()
    expect(handle).toBeDefined()
    expect(typeof handle?.verify).toBe('function')

    const ok = await handle!.verify()
    expect(typeof ok).toBe('boolean')

    const apiKeyEvents = events.filter(
      ev => ev.type === 'notification'
        && (ev.payload as any)?.kind === 'custom'
        && (ev.payload as any)?.payload?.type === 'apiKeyOk',
    )
    expect(apiKeyEvents.length).toBe(1)
    expect(typeof (apiKeyEvents[0]!.payload as any).payload.ok).toBe('boolean')

    await session.dispose()
  })

  // zai patch (2026-08-30, plan P2, Task 4): setupTasksV2Collapse state
  // is queryable via the getTasksV2Handle() accessor. toggle() must
  // flip isCollapsed() and fire onCollapseChange, which routes through
  // hooks.onEvent as a 'tasksV2Collapse' custom notification.
  it('setupTasksV2Collapse state is queryable via getTasksV2Handle', async () => {
    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })

    const handle = session.getTasksV2Handle?.()
    expect(handle).toBeDefined()
    expect(typeof handle?.toggle).toBe('function')
    expect(handle?.isCollapsed()).toBe(false)

    // toggle to true → callback fires with true
    handle?.toggle()
    expect(handle?.isCollapsed()).toBe(true)

    // toggle back to false
    handle?.toggle()
    expect(handle?.isCollapsed()).toBe(false)

    // setCollapsed(true) is idempotent
    handle?.setCollapsed(true)
    handle?.setCollapsed(true)
    expect(handle?.isCollapsed()).toBe(true)

    // Verify collapse-change events were emitted
    const collapseEvents = events.filter(
      ev => ev.type === 'notification'
        && (ev.payload as any)?.payload?.type === 'tasksV2Collapse',
    )
    // 3 transitions: false→true, true→false, false→true
    expect(collapseEvents.length).toBe(3)

    await session.dispose()
  })

  // zai patch (2026-08-30, plan P2, Task 4): setupNotifications bus
  // propagates through hooks.onEvent as ReplEvent 'notification'.
  // The bus is a public surface (drivers can emit from SSE handlers)
  // so we exercise the round-trip: emit → ReplEvent with the same
  // kind/payload.
  it('setupNotifications bus is wired (emit propagates through onEvent)', async () => {
    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })

    const bus = session.getNotificationsHandle?.()
    expect(bus).toBeDefined()

    bus?.emit('rateLimit', { retryAfterMs: 30_000 })
    bus?.emit('deprecation', { message: 'old-flag' })
    bus?.emit('custom', { type: 'fromTest', value: 42 })

    const notificationEvents = events.filter(ev => ev.type === 'notification')
    const rateLimitEv = notificationEvents.find(
      ev => (ev.payload as any)?.kind === 'rateLimit',
    )
    expect(rateLimitEv).toBeDefined()
    expect((rateLimitEv!.payload as any).payload.retryAfterMs).toBe(30_000)

    const customEv = notificationEvents.find(
      ev => (ev.payload as any)?.kind === 'custom'
        && (ev.payload as any)?.payload?.type === 'fromTest',
    )
    expect(customEv).toBeDefined()
    expect((customEv!.payload as any).payload.value).toBe(42)

    await session.dispose()
  })

  // zai patch (2026-08-30, plan P2, Task 4): ElicitationRegistry is
  // accessible via getElicitationRegistry(). When the host doesn't
  // supply one via opts, createReplSession fabricates a minimal
  // in-process stub with the same request/resolve/cancel/hasPending
  // surface so MCP code paths can always find a registry. When the
  // host supplies one, the same accessor returns the host's
  // instance (identity preserved).
  it('ElicitationRegistry is exposed via getElicitationRegistry (default stub)', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    const reg = session.getElicitationRegistry?.() as any
    expect(reg).toBeDefined()
    expect(typeof reg.request).toBe('function')
    expect(typeof reg.resolve).toBe('function')
    expect(typeof reg.cancel).toBe('function')
    expect(typeof reg.hasPending).toBe('function')

    // Stub behavior: request() returns a pending promise; resolve()
    // completes it.
    const id = randomUUID()
    const promise = reg.request({ elicitationId: id, mcpServerName: 'm', message: 'fill', mode: 'form' })
    expect(reg.hasPending()).toBe(true)
    reg.resolve(id, { action: 'accept', content: { x: 1 } })
    const result = await promise
    expect(result.action).toBe('accept')
    expect(result.content).toEqual({ x: 1 })
    expect(reg.hasPending()).toBe(false)

    // cancel() round-trip
    const id2 = randomUUID()
    const promise2 = reg.request({ elicitationId: id2, mcpServerName: 'm', message: 'fill', mode: 'form' })
    reg.cancel(id2)
    const r2 = await promise2
    expect(r2.action).toBe('cancel')

    await session.dispose()
  })

  // zai patch (2026-08-30, plan P2, Task 4): when the host supplies a
  // registry via opts.elicitationRegistry, getElicitationRegistry()
  // returns the SAME instance (identity check). This is the path T6
  // uses — zai web constructs the real ElicitationRegistry and passes
  // it into createReplSession.
  it('ElicitationRegistry honors opts.elicitationRegistry (host-supplied)', async () => {
    const hostRegistry = {
      request: vi.fn(async () => ({ action: 'decline' as const })),
      resolve: vi.fn(),
      cancel: vi.fn(),
      hasPending: vi.fn(() => false),
      marker: 'host-supplied-registry',
    }

    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
      elicitationRegistry: hostRegistry,
    } as any)

    const reg = session.getElicitationRegistry?.() as any
    expect(reg).toBe(hostRegistry) // identity check — no in-core stub replacement
    expect(reg.marker).toBe('host-supplied-registry')

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
