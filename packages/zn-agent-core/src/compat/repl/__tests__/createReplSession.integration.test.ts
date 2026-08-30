// packages/zn-agent-core/src/compat/repl/__tests__/createReplSession.integration.test.ts
// @ts-nocheck
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Mock vendor chains that createReplSession depends on. Mirrors the mock
// pattern from createReplSession.smoke.test.ts so the test doesn't pull in
// the BashTool circular dep.
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

// Import after mocks are set up
import { createReplSession } from '../createReplSession.js'

describe('createReplSession P1 integration', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p1-int-'))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('restores messages from prior JSONL on create', async () => {
    const sessionId = `s-${randomUUID()}`
    const jsonlPath = join(tmpDir, '.zai', 'sessions', `${sessionId}.jsonl`)
    // Pre-populate JSONL
    require('fs').mkdirSync(join(tmpDir, '.zai', 'sessions'), { recursive: true })
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', parent_tool_use_id: null, session_id: sessionId }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, uuid: 'a1', parent_tool_use_id: null, session_id: sessionId }),
    ].join('\n'))

    const session = createReplSession({
      sessionId,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    // State should reflect restored session
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
})
