// packages/zn-agent-core/src/compat/repl/__tests__/sessionRestoreHydrate.test.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P3, Task 3): hydrate contract — restoreSession
 * must return a `hydrated` boolean indicating whether on-disk JSONL was
 * actually consumed, and createReplSession must expose a `whenHydrated()`
 * method that resolves once the restore promise settles. Spec §4.3.
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// bootstrap/state mock needed for transitive imports via createReplSession.
vi.mock('../../../opencc-src/bootstrap/state.js', async () => {
  const { AsyncLocalStorage } = await import('async_hooks')
  const sdkStorage = new AsyncLocalStorage<any>()
  return {
    runWithSdkContext: <T>(ctx: any, fn: () => T): T => sdkStorage.run(ctx, fn),
    getSessionId: () => sdkStorage.getStore()?.sessionId ?? 'mock',
  }
})

// Mock the messageQueueManager chain to keep test 3 from pulling in the
// BashTool / prompt.ts circular dep (same pattern as smoke + slash tests).
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

// mock ScheduleCronTool prompt (kairos flag)
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

// mock vendor query() so test 3 doesn't pull in the heavy query chain
vi.mock('../../../opencc-src/query.js', () => ({
  query: async function* () {
    yield { type: 'result' }
  },
}))

// mock translateSdkToRuntime (identity-ish passthrough)
vi.mock('../../../compat/runtime/sdkEventAdapter.js', () => ({
  translateSdkToRuntime: function* (_sdkMsg: unknown, _meta: unknown) {
    yield { type: 'passthrough', message: 'mock' }
  },
}))

// mock createUserMessage so the chain query.js → utils/messages.js doesn't
// evaluate the heavy attachments / BashTool graph.
vi.mock('../../../opencc-src/utils/messages.js', () => ({
  createUserMessage: (opts: any) => ({
    type: 'user',
    content: '',
    message: { role: 'user', content: opts.content ?? [] },
    uuid: opts.uuid,
  }),
}))

// Imports after mocks are set up
import { restoreSession } from '../sessionRestore.js'
import { createReplSession } from '../createReplSession.js'

describe('sessionRestore.hydrate', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p3-hyd-'))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('restoreSession returns messages from on-disk JSONL + hydrated=true', async () => {
    const sessDir = join(tmpDir, '.zai', 'sessions')
    mkdirSync(sessDir, { recursive: true })
    writeFileSync(
      join(sessDir, 'sess-hyd-1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }) + '\n',
    )
    const result = await restoreSession({
      sessionId: 'sess-hyd-1',
      cwd: tmpDir,
      getAppState: () => ({}),
      setAppState: () => {},
    })
    expect(result.messages.length).toBe(2)
    expect(result.hydrated).toBe(true)
  })

  it('restoreSession returns empty messages + hydrated=false when no on-disk session', async () => {
    const result = await restoreSession({
      sessionId: 'sess-nonexistent',
      cwd: tmpDir,
      getAppState: () => ({}),
      setAppState: () => {},
    })
    expect(result.messages).toEqual([])
    expect(result.hydrated).toBe(false)
  })

  it('createReplSession.whenHydrated() resolves after restore completes', async () => {
    const sessDir = join(tmpDir, '.zai', 'sessions')
    mkdirSync(sessDir, { recursive: true })
    writeFileSync(
      join(sessDir, 'sess-hyd-2.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'persisted' } }) + '\n',
    )
    const session = createReplSession({
      sessionId: 'sess-hyd-2',
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })
    const result = await session.whenHydrated()
    expect(result.hydrated).toBe(true)
    expect(result.messages.length).toBe(1)
    await session.dispose()
  })
})
