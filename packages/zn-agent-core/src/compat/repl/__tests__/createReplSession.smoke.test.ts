// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): createReplSession smoke tests.
 * Verifies the imperative ReplSession interface: submit / enqueue /
 * interrupt / endSession / on / dispose / getState. ALS-wrapped turn
 * path runs without throwing; vendor query() integration lands in
 * Task 8.
 */

import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// NOTE: bootstrap/state.ts pulls in a heavy module chain (settingsCache →
// tools.ts → BashTool → prompt.ts → timeouts.js) that fails to evaluate
// under vitest ESM because of a circular dep where getMaxTimeoutMs is
// undefined at prompt.ts evaluation time. We mock just the two symbols
// createReplSession actually consumes: runWithSdkContext (real ALS via
// AsyncLocalStorage) and getSessionId (used by tests / future hooks).
vi.mock('../../../opencc-src/bootstrap/state.js', async () => {
  const { AsyncLocalStorage } = await import('async_hooks')
  const sdkStorage = new AsyncLocalStorage<any>()
  return {
    runWithSdkContext: <T>(ctx: any, fn: () => T): T =>
      sdkStorage.run(ctx, fn),
    getSessionId: () => sdkStorage.getStore()?.sessionId ?? 'mock-session',
  }
})

// mock messageQueueManager chain so cmdQueue enqueue doesn't trigger
// BashTool evaluation through the existing tools.ts re-export graph.
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

// mock cronScheduler chain (same pattern as setupCronScheduler.test.ts)
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

// mock proactive module + growthbook gate (same pattern as setupProactive.test.ts)
vi.mock('../../../opencc-src/proactive/index.js', () => ({
  subscribeToProactiveChanges: vi.fn(() => () => {}),
}))

vi.mock('../../../opencc-src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: vi.fn(() => false),
}))

// mock vendor query() (Task 8): replace with a no-op async generator so
// the smoke test doesn't pull in query.ts's heavy chain (claude.ts →
// promptCache → utils/attachments → settingsCache → BashTool). The
// dedicated query-integration test (createReplSession.query.test.ts)
// verifies the call shape with controlled fixtures.
vi.mock('../../../opencc-src/query.js', () => ({
  query: async function* () {
    // emit a single result SDKMessage so translateSdkToRuntime (also
    // mocked below) has something to see; the smoke tests only assert
    // on turnStart/turnEnd lifecycle, not on runtime payloads.
    yield { type: 'result' }
  },
}))

// mock translateSdkToRuntime (Task 8): identity-ish passthrough so the
// smoke test asserts on lifecycle events without depending on the real
// adapter's event-shape semantics. The dedicated query-integration test
// covers real adapter behaviour.
vi.mock('../../../compat/runtime/sdkEventAdapter.js', () => ({
  translateSdkToRuntime: function* (_sdkMsg: unknown, _meta: unknown) {
    yield { type: 'passthrough', message: 'mock' }
  },
}))

// mock createUserMessage: trivial passthrough so the chain
// query.js → utils/messages.js → ... doesn't evaluate the heavy
// attachments / BashTool graph in the smoke test.
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

describe('createReplSession smoke', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p0-smoke-'))

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates a session and reports correct initial state', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    const state = session.getState()
    expect(state.sessionId.startsWith('s-')).toBe(true)
    expect(state.isRunning).toBe(false)
    expect(state.isDisposed).toBe(false)
    expect(state.turnIndex).toBe(0)

    await session.dispose()
  })

  it('submit increments turnIndex and emits turnStart+turnEnd events', async () => {
    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })

    await session.submit([{ type: 'text', text: 'hello' }])

    const types = events.map((e: any) => e.type)
    expect(types).toContain('turnStart')
    expect(types).toContain('turnEnd')
    expect(session.getState().turnIndex).toBe(1)
    expect(session.getState().isRunning).toBe(false)

    await session.dispose()
  })

  it('interrupt before any turn is a no-op', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    await expect(session.interrupt('test')).resolves.toBeUndefined()
    await session.dispose()
  })

  it('endSession before any turn is a no-op', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    await expect(session.endSession('test')).resolves.toBeUndefined()
    await session.dispose()
  })

  it('on returns an unsubscribe function and is idempotent', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    const unsub = session.on('turnEnd', () => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
    expect(() => unsub()).not.toThrow() // idempotent
    await session.dispose()
  })

  it('lifecycle subscriber receives turnEnd payload', async () => {
    let received: any = null
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    session.on('turnEnd', payload => { received = payload })
    await session.submit([{ type: 'text', text: 'x' }])
    expect(received).not.toBeNull()
    expect(typeof received).toBe('object')
    expect((received as any).turnIndex).toBe(1)

    await session.dispose()
  })

  it('dispose marks session disposed and is idempotent', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    await session.dispose()
    expect(session.getState().isDisposed).toBe(true)
    await expect(session.dispose()).resolves.toBeUndefined()
  })

  it('submit after dispose throws', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    await session.dispose()
    await expect(session.submit([])).rejects.toThrow(/disposed/)
  })

  it('enqueue accepts priority variants without throwing', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    await expect(
      session.enqueue([{ type: 'text', text: 'a' }], 'now'),
    ).resolves.toBeUndefined()
    await expect(
      session.enqueue([{ type: 'text', text: 'b' }], 'next'),
    ).resolves.toBeUndefined()
    await expect(
      session.enqueue([{ type: 'text', text: 'c' }], 'later'),
    ).resolves.toBeUndefined()
    await session.dispose()
  })
})