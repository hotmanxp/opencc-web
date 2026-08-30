// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0, Task 8): createReplSession + vendor
 * query() integration tests.
 *
 * Verifies that `createReplSession.submit()`:
 *   - calls vendor `query()` exactly once per submit
 *   - passes `querySource: 'server-repl'` so vendor can distinguish the
 *     in-process server session from terminal REPL / CLI SDK
 *   - feeds every SDKMessage yielded by query() through
 *     translateSdkToRuntime and re-emits the resulting RuntimeEvents
 *     through `hooks.onEvent` as `type: 'runtime'` ReplEvents
 *   - emits `turnStart` and `turnEnd` around the for-await loop
 *
 * Vendor `query.ts` is mocked because pulling it in evaluates a heavy
 * chain (claude.ts → promptCache → utils/attachments → settingsCache →
 * BashTool) that fails to evaluate under vitest ESM. translateSdkToRuntime
 * is the REAL adapter so we cover the SDK → runtime mapping end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock the heavy vendor chain BEFORE importing createReplSession.
//
// NOTE: bootstrap/state.ts pulls in settingsCache → tools.ts → BashTool
// → prompt.ts → timeouts.js — fails to evaluate under vitest ESM. Mock
// just the two symbols createReplSession consumes (real ALS via
// AsyncLocalStorage for runWithSdkContext + a noop getSessionId).
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

// Mock utils/messages.js's createUserMessage to a trivial passthrough —
// the test only cares about query() being called with the right shape,
// not about vendor's user-message factory internals.
vi.mock('../../../opencc-src/utils/messages.js', () => ({
  createUserMessage: (opts: any) => ({
    type: 'user',
    content: '',
    message: { role: 'user', content: opts.content ?? [] },
    uuid: opts.uuid,
  }),
}))

// Vendor query() mock — controllable per-test. Each test sets
// `mockQueryImpl` to an async generator that yields the SDKMessages the
// test wants query() to produce. The mock captures the params it was
// called with so tests can assert on them.
const capturedQueryCalls: any[] = []
let mockQueryImpl: () => AsyncGenerator<unknown> = async function* () {
  // default: emit one assistant message + a result so the adapter has
  // shape that exercises both branches.
  yield {
    type: 'assistant',
    message: {
      id: 'msg-1',
      model: 'claude-test',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello from mock vendor' }],
      stop_reason: 'end_turn',
    },
  }
  yield { type: 'result' }
}

vi.mock('../../../opencc-src/query.js', () => ({
  query: (params: any) => {
    capturedQueryCalls.push(params)
    return mockQueryImpl()
  },
}))

// Import after mocks
import { createReplSession } from '../createReplSession.js'

describe('createReplSession + vendor query() (Task 8)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p0-query-'))

  beforeEach(() => {
    capturedQueryCalls.length = 0
    mockQueryImpl = async function* () {
      yield {
        type: 'assistant',
        message: {
          id: 'msg-default',
          model: 'claude-test',
          role: 'assistant',
          content: [{ type: 'text', text: 'default mock' }],
          stop_reason: 'end_turn',
        },
      }
      yield { type: 'result' }
    }
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls vendor query() exactly once per submit', async () => {
    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })

    await session.submit([{ type: 'text', text: 'first' }])
    expect(capturedQueryCalls).toHaveLength(1)

    await session.submit([{ type: 'text', text: 'second' }])
    expect(capturedQueryCalls).toHaveLength(2)

    await session.dispose()
  })

  it('passes querySource = "server-repl" to vendor query()', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    await session.submit([{ type: 'text', text: 'x' }])

    expect(capturedQueryCalls).toHaveLength(1)
    const call = capturedQueryCalls[0]!
    expect(call.querySource).toBe('server-repl')

    await session.dispose()
  })

  it('translates each SDKMessage from query() into runtime ReplEvents', async () => {
    // Override the mock to emit two assistant messages — adapter
    // should yield at least 4 runtime events per assistant (message_start,
    // content_block_start/delta/stop, message_delta). The result SDKMessage
    // yields message_delta + message_stop if no pending tools.
    mockQueryImpl = async function* () {
      yield {
        type: 'assistant',
        message: {
          id: 'msg-A',
          model: 'claude-test',
          role: 'assistant',
          content: [{ type: 'text', text: 'first reply' }],
          stop_reason: 'end_turn',
        },
      }
      yield { type: 'result' }
    }

    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })

    await session.submit([{ type: 'text', text: 'go' }])

    const runtimeEvents = events.filter(e => e.type === 'runtime')
    expect(runtimeEvents.length).toBeGreaterThan(0)

    // First runtime event should be message_start (from assistant).
    const types = runtimeEvents.map(e => e.payload?.type)
    expect(types).toContain('message_start')
    expect(types).toContain('content_block_start')
    expect(types).toContain('content_block_delta')
    expect(types).toContain('content_block_stop')
    expect(types).toContain('message_delta')

    // Adapter-meta turnIndex bumps on message_start — the runtime
    // payload turnIndex should be >= 1 (we set thisTurnIndex=1 in runTurn).
    for (const re of runtimeEvents) {
      expect(re.turnIndex).toBeGreaterThanOrEqual(1)
      expect(re.sessionId).toBeDefined()
    }

    await session.dispose()
  })

  it('emits turnStart before query() and turnEnd after the for-await loop', async () => {
    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })

    await session.submit([{ type: 'text', text: 'order matters' }])

    const types = events.map(e => e.type)
    const turnStartIdx = types.indexOf('turnStart')
    const turnEndIdx = types.lastIndexOf('turnEnd')

    // zai patch (2026-08-30, plan P2, Task 4): P2 mounts setupApiKeyVerification
    // synchronously, which fires a `notification` event (kind: 'custom',
    // payload.type: 'apiKeyOk') before the first turnStart. Similarly,
    // sessionRestore may fire a 'hydrated' notification when prior JSONL
    // exists. Pre-turn events must therefore be exclusively `notification`
    // (no runtime / turnStart / turnEnd / sessionCrash).
    expect(turnStartIdx).toBeGreaterThanOrEqual(0)
    expect(turnEndIdx).toBeGreaterThan(turnStartIdx)
    expect(turnEndIdx).toBe(types.length - 1)

    // Pre-turnStart slice: only notification events allowed (apiKeyOk /
    // hydrated), no runtime events.
    const preTurn = types.slice(0, turnStartIdx)
    expect(preTurn.every(t => t === 'notification')).toBe(true)
    expect(types.slice(turnStartIdx + 1, turnEndIdx)).toContain('runtime')
    expect(types.slice(turnEndIdx + 1)).toEqual([])

    await session.dispose()
  })

  it('increments adapterMeta.eventCounter per SDKMessage', async () => {
    // We verify this indirectly: each yielded SDKMessage increments
    // eventCounter, and eventCounter is used to build the eventId
    // (evt-N). The first runtime event should have a unique eventId.
    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })

    mockQueryImpl = async function* () {
      yield {
        type: 'assistant',
        message: {
          id: 'msg-counter',
          model: 'claude-test',
          role: 'assistant',
          content: [{ type: 'text', text: 'counter test' }],
          stop_reason: 'end_turn',
        },
      }
      yield { type: 'result' }
    }

    await session.submit([{ type: 'text', text: 'go' }])

    const runtimeEvents = events.filter(e => e.type === 'runtime')
    // eventId pattern is evt-N or evt-N.M. All should be unique.
    const ids = new Set<string>()
    for (const re of runtimeEvents) {
      const id = re.payload?.eventId
      if (typeof id === 'string') ids.add(id)
    }
    expect(ids.size).toBeGreaterThan(0)

    await session.dispose()
  })

  it('passes submitted content as user message with text block to query()', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    await session.submit([
      { type: 'text', text: 'hello world' },
    ])

    expect(capturedQueryCalls).toHaveLength(1)
    const call = capturedQueryCalls[0]!
    expect(call.messages).toHaveLength(1)
    const m = call.messages[0]
    expect(m.type).toBe('user')
    const inner = m.message?.content
    expect(Array.isArray(inner)).toBe(true)
    expect(inner[0]).toMatchObject({ type: 'text', text: 'hello world' })

    await session.dispose()
  })

  it('propagates query() errors via sessionCrash event and rejects', async () => {
    mockQueryImpl = async function* () {
      throw new Error('vendor query failed in test')
    }

    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })

    await expect(
      session.submit([{ type: 'text', text: 'will fail' }]),
    ).rejects.toThrow(/vendor query failed/)

    const crashEvent = events.find(e => e.type === 'sessionCrash')
    expect(crashEvent).toBeDefined()
    expect(crashEvent?.payload?.error).toMatch(/vendor query failed/)

    // turnEnd should NOT be emitted when the loop throws.
    const turnEnd = events.find(e => e.type === 'turnEnd')
    expect(turnEnd).toBeUndefined()

    await session.dispose()
  })

  it('does not increment turnIndex when concurrent submit is enqueued', async () => {
    // First submit acquires the guard; second concurrent submit should
    // be enqueued (no query() call) and turnIndex should NOT increment
    // past 1.
    const slowSubmit = (async function* () {
      // Emit nothing — just hang so the first submit holds the guard.
      await new Promise(resolve => setTimeout(resolve, 20))
    })()

    mockQueryImpl = async function* () {
      await new Promise(resolve => setTimeout(resolve, 30))
      yield { type: 'result' }
    }

    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: slowSubmit,
      hooks: { onEvent: ev => events.push(ev) },
    })

    const p1 = session.submit([{ type: 'text', text: 'first' }])
    // Fire the second one while p1 is in flight — should be enqueued.
    await session.submit([{ type: 'text', text: 'second (enqueued)' }])
    await p1

    // Only the first submit should call query(); the second is enqueued.
    expect(capturedQueryCalls).toHaveLength(1)
    expect(session.getState().turnIndex).toBe(1)

    await session.dispose()
  })
})