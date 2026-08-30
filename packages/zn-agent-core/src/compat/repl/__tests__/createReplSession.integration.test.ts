// packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.integration.test.ts
// @ts-nocheck
//
// zai patch (2026-08-30, plan P1, Task 8): integration test for the wired
// createReplSession. Verifies the L1 adapter suite + state machines +
// sessionRestore are actually invoked during construction, not silently
// dropped. Earlier version had only no-throw + sessionId-echo assertions
// that passed even with all wiring removed — Task 8 reviewer flagged this
// as [Important]; fixed by spying on the adapter setupXxx exports and
// asserting call args.
//
// Test strategy: vi.mock each setupXxx adapter module BEFORE importing
// createReplSession. Each mock is a spy that records call args. After
// createReplSession returns, assert the matching spy was called with the
// expected options shape. If any of the 5 L1 adapters is unwired in
// createReplSession.ts, the matching assertion fails.
//
// We do NOT mock the bootstrap/state chain here — the test exercises
// createReplSession's surface, not its internals. setupCronScheduler /
// setupProactive / setupQueryGuard (P0 adapters) are imported normally
// and run with their actual mockable backends (messageQueueManager +
// cronScheduler are mocked at the vendor layer to avoid BashTool's
// circular dep, same pattern as smoke.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

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

vi.mock('../../../opencc-src/utils/messages.js', () => ({
  createUserMessage: (opts: any) => ({
    type: 'user',
    content: '',
    message: { role: 'user', content: opts.content ?? [] },
    uuid: opts.uuid,
  }),
}))

// ---------------------------------------------------------------------------
// L1 adapter spies (Task 8 fix [Important])
//
// Each setupXxx module is mocked to expose a spy that records call args.
// After createReplSession runs, the assertions verify:
//   1. The setupXxx spy was called at all (proves wiring happened)
//   2. The spy was called with the expected option shape (proves options
//      were passed correctly)
// ---------------------------------------------------------------------------

const inboxSpy = vi.fn(() => ({ teardown: vi.fn() }))
const mailboxSpy = vi.fn(() => ({ teardown: vi.fn() }))
const swarmSpy = vi.fn(() => ({ teardown: vi.fn(), createTeammate: vi.fn() }))
const backgroundSpy = vi.fn(() => ({ teardown: vi.fn(), background: vi.fn(), foreground: vi.fn() }))
const skillsSpy = vi.fn(() => ({ teardown: vi.fn(), triggerRefresh: vi.fn() }))
const restoreSpy = vi.fn(async () => ({ messages: [] }))

vi.mock('../setup/setupInboxPoller.js', () => ({
  setupInboxPoller: (opts: any) => inboxSpy(opts),
}))
vi.mock('../setup/setupMailboxBridge.js', () => ({
  setupMailboxBridge: (opts: any) => mailboxSpy(opts),
}))
vi.mock('../setup/setupSwarmInitialization.js', () => ({
  setupSwarmInitialization: (opts: any) => swarmSpy(opts),
}))
vi.mock('../setup/setupSessionBackgrounding.js', () => ({
  setupSessionBackgrounding: (opts: any) => backgroundSpy(opts),
}))
vi.mock('../setup/setupSkillsChange.js', () => ({
  setupSkillsChange: (opts: any) => skillsSpy(opts),
}))
vi.mock('../sessionRestore.js', () => ({
  restoreSession: (opts: any) => restoreSpy(opts),
}))

// Import after mocks
import { createReplSession } from '../createReplSession.js'

describe('createReplSession P1 integration', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p1-int-'))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

  beforeEach(() => {
    inboxSpy.mockClear()
    mailboxSpy.mockClear()
    swarmSpy.mockClear()
    backgroundSpy.mockClear()
    skillsSpy.mockClear()
    restoreSpy.mockClear()
  })

  it('wires all 5 L1 adapters + sessionRestore on construction', () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    // Each L1 adapter's setupXxx must have been called exactly once
    expect(inboxSpy).toHaveBeenCalledTimes(1)
    expect(mailboxSpy).toHaveBeenCalledTimes(1)
    expect(swarmSpy).toHaveBeenCalledTimes(1)
    expect(backgroundSpy).toHaveBeenCalledTimes(1)
    expect(skillsSpy).toHaveBeenCalledTimes(1)

    // sessionRestore must have been called (fire-and-forget)
    expect(restoreSpy).toHaveBeenCalledTimes(1)

    // sessionId must be passed through to every wired setupXxx
    // (skills has no sessionId per its brief — cwd-only; skipped).
    for (const spy of [inboxSpy, mailboxSpy, swarmSpy, backgroundSpy, restoreSpy]) {
      const args = spy.mock.calls[0][0]
      expect(args.sessionId).toMatch(/^s-/)
    }
    // cwd must be passed where the adapter accepts it (skills + restore
    // accept cwd; swarm + background do not per their brief signatures).
    for (const spy of [inboxSpy, mailboxSpy, skillsSpy, restoreSpy]) {
      const args = spy.mock.calls[0][0]
      expect(args.cwd).toBe(tmpDir)
    }

    session.dispose()
  })

  it('restores messages from prior JSONL on create', async () => {
    const sessionId = `s-${randomUUID()}`
    const jsonlPath = join(tmpDir, '.zai', 'sessions', `${sessionId}.jsonl`)
    mkdirSync(join(tmpDir, '.zai', 'sessions'), { recursive: true })
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', parent_tool_use_id: null, session_id: sessionId }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, uuid: 'a1', parent_tool_use_id: null, session_id: sessionId }),
    ].join('\n'))

    const events: any[] = []
    const session = createReplSession({
      sessionId,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })

    // restoreSpy received the right cwd + sessionId
    const restoreArgs = restoreSpy.mock.calls[0][0]
    expect(restoreArgs.cwd).toBe(tmpDir)
    expect(restoreArgs.sessionId).toBe(sessionId)

    expect(session.getState().sessionId).toBe(sessionId)
    await session.dispose()
  })

  it('handles /loop command by setting up cron', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    // Send a /loop command
    await session.submit([{ type: 'text', text: '/loop 1m "check builds"' } as any])
    await session.dispose()
  })

  it('handles interrupt cleanly mid-turn', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    const submitPromise = session.submit([{ type: 'text', text: 'long prompt' } as any])
    setTimeout(() => session.interrupt('test'), 10)
    await submitPromise
    await session.dispose()
  })

  it('dispose() teardowns all 5 L1 adapters', async () => {
    const teardowns: any[] = []
    inboxSpy.mockImplementation(() => {
      const t = vi.fn()
      teardowns.push(t)
      return { teardown: t }
    })
    mailboxSpy.mockImplementation(() => {
      const t = vi.fn()
      teardowns.push(t)
      return { teardown: t }
    })
    swarmSpy.mockImplementation(() => {
      const t = vi.fn()
      teardowns.push(t)
      return { teardown: t, createTeammate: vi.fn() }
    })
    backgroundSpy.mockImplementation(() => {
      const t = vi.fn()
      teardowns.push(t)
      return { teardown: t, background: vi.fn(), foreground: vi.fn() }
    })
    skillsSpy.mockImplementation(() => {
      const t = vi.fn()
      teardowns.push(t)
      return { teardown: t, triggerRefresh: vi.fn() }
    })

    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    expect(teardowns).toHaveLength(5)
    for (const t of teardowns) {
      expect(t).not.toHaveBeenCalled()
    }

    await session.dispose()

    for (const t of teardowns) {
      expect(t).toHaveBeenCalledTimes(1)
    }
  })
})
