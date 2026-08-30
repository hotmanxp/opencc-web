// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P3.1-T1): createReplSession.runTurn
 * end-to-end tests. Verifies:
 *
 *   - mock vendor `query()` to immediately yield one assistant
 *     Message + return a Terminal, and confirm createReplSession.runTurn
 *     (called via session.submit) emits `turnStart` then `turnEnd`
 *     (the exact "no hang" path the P3 baseline report flagged).
 *   - hang-up protection: if vendor `query()` yields a stream but never
 *     returns (simulating a hung API call), session.interrupt() must
 *     still resolve and the session must surface `turnEnd`.
 *
 * Mock chain mirrors toolUseContext.test.ts so the full mock set is
 * consistent with the existing P3-T0 test infrastructure. Per-test setup
 * (session construction, event capture, disposal) lives in the
 * `newSession()` helper + beforeEach/afterEach so each `it` body only
 * carries its own scenario.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Vendor chain mocks (BashTool circular dep isolation)
// ---------------------------------------------------------------------------

vi.mock('../../../opencc-src/bootstrap/state.js', async () => {
  const { AsyncLocalStorage } = await import('async_hooks')
  const sdkStorage = new AsyncLocalStorage<any>()
  return {
    runWithSdkContext: <T>(ctx: any, fn: () => T): T =>
      sdkStorage.run(ctx, fn),
    getSessionId: () => sdkStorage.getStore()?.sessionId ?? 'mock-session',
  }
})

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
  createCronScheduler: () => ({ start: () => {}, stop: () => {} }),
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

// Mock the vendor tool/command/cache/abort modules that createReplSession's
// ToolUseContext population calls when host opts are absent. Mirrors the
// toolUseContext.test.ts chain so runTurn can complete without pulling in
// BashTool → prompt.ts (which fails `getMaxTimeoutMs is not a function`
// under vitest ESM).
vi.mock('../../../opencc-src/tools.js', () => ({
  getTools: (_permissionContext: any) => ({
    Bash: { name: 'Bash' },
    Read: { name: 'Read' },
    Write: { name: 'Write' },
    Edit: { name: 'Edit' },
  }),
}))

vi.mock('../../../opencc-src/commands.js', () => ({
  getCommands: async (_cwd: string) => [{ name: 'help' }, { name: 'clear' }],
}))

vi.mock('../../../opencc-src/utils/fileStateCache.js', () => ({
  createFileStateCacheWithSizeLimit: () => ({
    get: () => undefined,
    set: () => undefined,
    has: () => false,
    delete: () => false,
    clear: () => undefined,
    size: 0,
    max: 100,
  }),
}))

vi.mock('../../../opencc-src/utils/abortController.js', () => ({
  createAbortController: () => new AbortController(),
}))

// Vendor query() mock — controllable per-test. `assistantTurn()` builds
// the default impl: immediately yields one assistant Message then returns
// a Terminal-success value, so createReplSession.runTurn's `for await (...)`
// loop completes and turnEnd is emitted. Tests that want to exercise hang /
// error paths assign `mockQueryImpl` before submitting.
const capturedQueryCalls: any[] = []

/**
 * Default vendor `query()` behaviour: one assistant text message, then a
 * Terminal. The Terminal return value is discarded by runTurn (the caller
 * doesn't read the generator's return value); what matters is that the
 * generator *completes*, letting the for-await loop fall through to turnEnd.
 */
function assistantTurn(
  text = 'hello from mock vendor',
  id = 'msg-1',
): () => AsyncGenerator<unknown> {
  return async function* () {
    yield {
      type: 'assistant',
      message: {
        id,
        model: 'claude-test',
        role: 'assistant',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
      },
    }
    return { type: 'terminal', success: true } as any
  }
}

let mockQueryImpl: () => AsyncGenerator<unknown> = assistantTurn()

vi.mock('../../../opencc-src/query.js', () => ({
  query: (params: any) => {
    capturedQueryCalls.push(params)
    return mockQueryImpl()
  },
}))

// Import after mocks
import { createReplSession } from '../createReplSession.js'

describe('createReplSession.runTurn (P3.1-T1 — vendor query() no-hang)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p31-runt-'))
  const openSessions: Array<ReturnType<typeof createReplSession>> = []

  /**
   * Single session factory for every test: fresh sessionId, shared tmp cwd,
   * empty input generator, and an `events` array wired to hooks.onEvent.
   * Sessions are disposed collectively in afterEach so each `it` body only
   * contains its own scenario + assertions.
   */
  function newSession(): {
    session: ReturnType<typeof createReplSession>
    events: any[]
  } {
    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })
    openSessions.push(session)
    return { session, events }
  }

  beforeEach(() => {
    capturedQueryCalls.length = 0
    mockQueryImpl = assistantTurn('default mock', 'msg-default')
  })

  afterEach(async () => {
    // dispose() must stay safe even while a hung runTurn is still parked
    // inside the mock generator (see the interrupt test).
    await Promise.all(
      openSessions.splice(0).map(s => s.dispose().catch(() => {})),
    )
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('emits turnEnd after vendor query() completes (no hang)', async () => {
    const { session, events } = newSession()

    // submit() should resolve (not hang) once the mocked vendor query()
    // returns its Terminal value.
    await session.submit([{ type: 'text', text: 'hello' }])

    const types = events.map(e => e.type)
    const turnStartIdx = types.indexOf('turnStart')
    const turnEndIdx = types.lastIndexOf('turnEnd')

    // Brief acceptance: vendor query() no longer hangs → turnEnd fires,
    // after turnStart, with no sessionCrash in between (the hang-up
    // protection path would emit sessionCrash + throw).
    expect(turnStartIdx).toBeGreaterThanOrEqual(0)
    expect(turnEndIdx).toBeGreaterThan(turnStartIdx)
    expect(events.find(e => e.type === 'sessionCrash')).toBeUndefined()

    // A completed (non-interrupted) turn must NOT be tagged as interrupted.
    const turnEnd = events[turnEndIdx]
    expect(turnEnd?.payload?.reason).not.toBe('interrupted')
  })

  it('runs turnEnd after a single-message assistant turn', async () => {
    const { session } = newSession()

    await session.submit([{ type: 'text', text: 'go' }])

    // After the mock query() returned a Terminal-success, runTurn's
    // finally-block set isRunning=false. getState() reflects that.
    const st = session.getState() as any
    expect(st.isRunning).toBe(false)
    expect(st.turnIndex).toBe(1)
  })

  it('hang-up protection: interrupt() emits synthetic turnEnd{reason:interrupted}', async () => {
    // Simulate a hung vendor call: the mock query generator yields one
    // message then hangs forever. The for-await loop in runTurn is
    // parked waiting for the next yield. interrupt() must rescue by
    // emitting a synthetic turnEnd ReplEvent (the brief's acceptance
    // criterion: "ESC 中断无 crash, turnEnd{reason:'interrupted'} 事件 emit").
    // Note: the submit() promise stays parked inside the hung for-await
    // (that's a separate hardening task — see P3.1-T2 plan). What we
    // verify here is that the UI receives the turnEnd event so the
    // "对话中" status can transition back to "就绪".
    mockQueryImpl = async function* () {
      yield {
        type: 'assistant',
        message: {
          id: 'msg-hung',
          model: 'claude-test',
          role: 'assistant',
          content: [{ type: 'text', text: 'partial response...' }],
          stop_reason: null,
        },
      }
      // Hang forever (no `return`). The for-await loop in runTurn is
      // parked here. interrupt() flips isRunning=false and emits
      // synthetic turnEnd ReplEvent.
      await new Promise(resolve => setTimeout(resolve, 30_000))
      yield { type: 'unreachable' }
    }

    const { session, events } = newSession()

    // Fire submit() but don't await — it will hang in the mock. The noop
    // .catch keeps the hung promise from raising unhandled-rejection
    // warnings if it eventually rejects during dispose().
    void session.submit([{ type: 'text', text: 'will hang' }]).catch(() => {})

    // Give the submit() microtask a chance to enter runTurn's for-await.
    await new Promise(resolve => setTimeout(resolve, 50))

    // interrupt() must NOT throw.
    await expect(session.interrupt('user pressed ESC')).resolves.toBeUndefined()

    // Brief acceptance: turnEnd{reason:'interrupted'} is emitted.
    const types = events.map(e => e.type)
    expect(types).toContain('turnEnd')
    const turnEndEvent = events.find(e => e.type === 'turnEnd')
    expect(turnEndEvent?.payload?.reason).toBe('interrupted')
    expect(turnEndEvent?.payload?.interruptedReason).toBe('user pressed ESC')

    // turnStart must have fired before the hung for-await parked.
    expect(types).toContain('turnStart')
  }, 10_000)

  it('propagates vendor query() errors via sessionCrash and rejects', async () => {
    mockQueryImpl = async function* () {
      throw new Error('vendor query failed in runTurn test')
    }

    const { session, events } = newSession()

    await expect(
      session.submit([{ type: 'text', text: 'will fail' }]),
    ).rejects.toThrow(/vendor query failed/)

    const crashEvent = events.find(e => e.type === 'sessionCrash')
    expect(crashEvent).toBeDefined()
    expect(crashEvent?.payload?.error).toMatch(/vendor query failed/)

    // turnEnd should NOT be emitted when the loop throws.
    expect(events.find(e => e.type === 'turnEnd')).toBeUndefined()
  })

  it('increments turnIndex across successful turns', async () => {
    const { session } = newSession()

    await session.submit([{ type: 'text', text: 'first' }])
    expect(session.getState().turnIndex).toBe(1)

    await session.submit([{ type: 'text', text: 'second' }])
    expect(session.getState().turnIndex).toBe(2)
  })

  it('passes toolUseContext shape required by vendor query()', async () => {
    const { session } = newSession()

    await session.submit([{ type: 'text', text: 'go' }])

    expect(capturedQueryCalls).toHaveLength(1)
    const call = capturedQueryCalls[0]!
    expect(call.toolUseContext).toBeDefined()
    expect(call.toolUseContext.options).toBeDefined()
    expect(call.toolUseContext.abortController).toBeDefined()
    expect(call.toolUseContext.readFileState).toBeDefined()
    expect(typeof call.toolUseContext.getAppState).toBe('function')
    // querySource discriminator — vendor distinguishes server-repl from
    // terminal REPL and SDK paths via this field.
    expect(call.querySource).toBe('server-repl')
  })
})
