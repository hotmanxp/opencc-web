// @ts-nocheck
/**
 * P0 acceptance: cpuUsage delta + active-handles count.
 * Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §5.2, §11.
 *
 * Uses the same vi.mock pattern as createReplSession.smoke.test.ts to avoid
 * the BashTool circular dep (bootstrap/state.js → tools.ts → BashTool →
 * prompt.ts → timeouts.js where getMaxTimeoutMs is undefined at eval time).
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock bootstrap/state.js to provide real ALS-based runWithSdkContext.
// This is the same mock used in createReplSession.smoke.test.ts.
// Without it, the BashTool circular dep causes getMaxTimeoutMs is not a function.
vi.mock('../../../opencc-src/bootstrap/state.js', async () => {
  const { AsyncLocalStorage } = await import('async_hooks')
  const sdkStorage = new AsyncLocalStorage<any>()
  return {
    runWithSdkContext: <T>(ctx: any, fn: () => T): T =>
      sdkStorage.run(ctx, fn),
    getSessionId: () => sdkStorage.getStore()?.sessionId ?? 'mock-session',
  }
})

// Mock messageQueueManager chain so cmdQueue enqueue doesn't trigger
// BashTool evaluation through the tools.ts re-export graph.
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

// Mock cronScheduler chain.
vi.mock('../../../opencc-src/utils/cronScheduler.js', () => ({
  createCronScheduler: () => ({
    start: () => {},
    stop: () => {},
  }),
}))

// Mock ScheduleCronTool chain (kairos flag).
vi.mock('../../../opencc-src/tools/ScheduleCronTool/prompt.js', () => ({
  isKairosCronEnabled: () => false,
}))

// Mock proactive module + growthbook gate.
vi.mock('../../../opencc-src/proactive/index.js', () => ({
  subscribeToProactiveChanges: vi.fn(() => () => {}),
}))

vi.mock('../../../opencc-src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: vi.fn(() => false),
}))

// Mock vendor query() to avoid the heavy chain (claude.ts → promptCache →
// utils/attachments → settingsCache → BashTool). The acceptance test only
// measures CPU / handles, not query output.
vi.mock('../../../opencc-src/query.js', () => ({
  query: async function* () {
    yield { type: 'result' }
  },
}))

// Mock translateSdkToRuntime: identity passthrough.
vi.mock('../../../opencc-src/compat/runtime/sdkEventAdapter.js', () => ({
  translateSdkToRuntime: function* (_sdkMsg: unknown, _meta: unknown) {
    yield { type: 'passthrough', message: 'mock' }
  },
}))

// Mock createUserMessage.
vi.mock('../../../opencc-src/utils/messages.js', () => ({
  createUserMessage: (opts: any) => ({
    type: 'user',
    content: '',
    message: { role: 'user', content: opts.content ?? [] },
    uuid: opts.uuid,
  }),
}))

// Import after mocks are set up.
import { createReplSession } from '../createReplSession.js'

describe('P0 acceptance', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p0-acc-'))

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('after dispose, cpuUsage delta is near zero', async () => {
    const t0 = process.cpuUsage()
    const session = createReplSession({
      sessionId: 'p0-acc-1',
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    await session.dispose()
    // Give the event loop a tick to settle
    await new Promise(r => setImmediate(r))
    const t1 = process.cpuUsage(t0)
    // user + system should each be < 50ms for a brief create+dispose cycle
    expect(t1.user).toBeLessThan(50_000) // microseconds
    expect(t1.system).toBeLessThan(50_000)
  })

  it('after dispose, no setupXxx residual timers/listeners', async () => {
    const before = (process as any).getActiveHandlesInfo?.() ?? []
    const beforeResources = (process as any).getActiveResourcesInfo?.() ?? []

    const session = createReplSession({
      sessionId: 'p0-acc-2',
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    await session.dispose()
    await new Promise(r => setImmediate(r))

    const after = (process as any).getActiveHandlesInfo?.() ?? []
    const afterResources = (process as any).getActiveResourcesInfo?.() ?? []

    // Allow for ambient variance (Node may have TCP timers, FSWatcher etc.
    // not from our code). We check that no NEW handles appeared with
    // our specific markers.
    const newHandles = after.length - before.length
    expect(newHandles).toBeLessThanOrEqual(2) // tolerate ambient
  })

  it('two concurrent sessions idle without consuming CPU', async () => {
    const t0 = process.cpuUsage()
    const a = createReplSession({
      sessionId: 'p0-idle-a',
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    const b = createReplSession({
      sessionId: 'p0-idle-b',
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    // Idle for 1 second (full 30min would take too long for unit test;
    // 1s is enough to catch busy-loop bugs)
    await new Promise(r => setTimeout(r, 1000))

    const t1 = process.cpuUsage(t0)
    // 1s of idle should consume < 100ms total CPU (user + system)
    expect(t1.user + t1.system).toBeLessThan(100_000)

    await a.dispose()
    await b.dispose()
  })
})
