// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P3, Task 2): session.interrupt must not throw.
 * Browser-operator 12-path verification found Path 2/3 (ESC interrupt) emitting
 * `runtime.error (internal)` because the stub P0 interrupt didn't signal
 * any in-flight query loop. P3 fix: try/catch wrapper + isRunning=false +
 * OnQueryStateMachine.signalInterrupt() + synthetic turnEnd event so
 * ReplRuntime's onEvent listener converts it to runtime.done (not error).
 */

import { describe, it, expect, vi } from 'vitest'

// Mock bootstrap/state.js — see createReplSession.smoke.test.ts for the
// full rationale (heavy chain via settingsCache → tools.ts → BashTool →
// prompt.ts → timeouts.js fails to evaluate under vitest ESM because
// of a circular dep where getMaxTimeoutMs is undefined at prompt.ts
// evaluation time). Mock just the symbols the session surface consumes.
vi.mock('../../../opencc-src/bootstrap/state.js', async () => {
  const { AsyncLocalStorage } = await import('async_hooks')
  const sdkStorage = new AsyncLocalStorage<any>()
  return {
    runWithSdkContext: <T>(ctx: any, fn: () => T): T =>
      sdkStorage.run(ctx, fn),
    getSessionId: () => sdkStorage.getStore()?.sessionId ?? 'mock-session',
  }
})

// Mock messageQueueManager.js so cmdQueue enqueue doesn't trigger
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
    resetCommandQueue: () => { mockQueue = [] },
    subscribeToCommandQueue: () => () => {},
    hasCommandsInQueue: () => mockQueue.length > 0,
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

vi.mock('../../../opencc-src/query.js', () => ({
  query: async function* () {
    yield { type: 'result' }
  },
}))

vi.mock('../../compat/runtime/sdkEventAdapter.js', () => ({
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

// Static imports — must come AFTER all vi.mock() calls.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createReplSession } from '../createReplSession.js'

describe('session.interrupt (P3-T2 graceful path)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p3-int-'))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('interrupt does not throw', async () => {
    const session = createReplSession({
      sessionId: `s-int-${Date.now()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    await expect(session.interrupt('user-esc')).resolves.toBeUndefined()
    await session.dispose()
  })

  it('interrupt emits turnEnd with reason=interrupted', async () => {
    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-int-${Date.now() + 1}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })
    await session.interrupt('test-reason')
    await new Promise(resolve => setTimeout(resolve, 10))
    const turnEnds = events.filter(e => e.type === 'turnEnd')
    expect(turnEnds.length).toBeGreaterThanOrEqual(1)
    // emitReplEvent wraps the payload under `.payload` per the
    // ReplEvent type — `reason` / `interruptedReason` live there, not
    // on the envelope (mirrors the existing runTurn() turnEnd shape).
    expect(turnEnds[0].payload?.reason).toBe('interrupted')
    expect(turnEnds[0].payload?.interruptedReason).toBe('test-reason')
    await session.dispose()
  })

  it('interrupt is idempotent', async () => {
    const events: any[] = []
    const session = createReplSession({
      sessionId: `s-int-${Date.now() + 2}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: ev => events.push(ev) },
    })
    await session.interrupt('first')
    await session.interrupt('second')
    await session.interrupt('third')
    await new Promise(resolve => setTimeout(resolve, 10))
    const turnEnds = events.filter(e => e.type === 'turnEnd')
    expect(turnEnds.length).toBeGreaterThanOrEqual(3)
    for (const t of turnEnds as any[]) {
      expect(t.payload?.reason).toBe('interrupted')
    }
    await session.dispose()
  })
})
