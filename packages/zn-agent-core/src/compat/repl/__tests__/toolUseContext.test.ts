// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P3, Task 0): ToolUseContext population
 * tests for createReplSession.
 *
 * Before P3-T0, createReplSession.ts passed `toolUseContext: {} as any`
 * to vendor query(), which means the LLM never sees any tools and never
 * generates tool_use blocks. P3-T0 fixes this by populating a full
 * ToolUseContext from opts (commands / tools / model / mcpClients /
 * readFileState / getAppState) with vendor fallbacks.
 *
 * The test mocks vendor query() so it can capture the params it was
 * called with and assert on toolUseContext shape — without invoking
 * the real (heavy) query.ts graph.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// zai patch (2026-08-30, plan P3, Task 0): opt back into the lazy
// vendor graph so this test exercises the actual vendor fallback path
// (not just the host-override path). Other tests (smoke / query / p2
// etc.) leave this OFF so they don't trigger the BashTool →
// prompt.ts evaluation chain.
process.env.ZAI_P3_T0_FORCE_VENDOR_FALLBACK = '1'

// Same mock chain as createReplSession.query.test.ts — bootstrap/state
// pulls in settingsCache → tools.ts → BashTool → prompt.ts →
// timeouts.js where getMaxTimeoutMs is undefined at eval time. We only
// need runWithSdkContext here.
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

// zai patch (2026-08-30, plan P3, Task 0): mock vendor tool registry /
// commands / FileStateCache / AbortController so createReplSession's
// ToolUseContext population can run without pulling in the heavy
// tools.ts → BashTool → prompt.ts chain. The mocks provide controllable
// return values so we can assert the host-overrides-wins behavior
// without depending on real vendor behavior.
vi.mock('../../../opencc-src/tools.js', () => ({
  getTools: (_permissionContext: any) => ({
    Bash: { name: 'Bash' },
    Read: { name: 'Read' },
    Write: { name: 'Write' },
    Edit: { name: 'Edit' },
  }),
}))

vi.mock('../../../opencc-src/commands.js', () => ({
  getCommands: async (_cwd: string) => [
    { name: 'help' },
    { name: 'clear' },
  ],
}))

vi.mock('../../../opencc-src/utils/fileStateCache.js', () => ({
  // Minimal FileStateCache-shaped object so query()/claude.ts can read
  // .get / .set / .has / .delete without crashing. The full real class
  // pulls in lru-cache + path.normalize which is overkill for testing
  // shape — we only need it to be a valid object reference.
  createFileStateCacheWithSizeLimit: (_max: number, _maxBytes?: number) => ({
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
  createAbortController: (maxListeners?: number) => {
    const controller = new AbortController()
    return controller
  },
}))

// Capture vendor query() call params so tests can assert on
// toolUseContext shape without invoking the real (heavy) query.ts
// chain. Default: emit a single result SDKMessage so the for-await
// loop completes cleanly.
const capturedQueryCalls: any[] = []
let mockQueryImpl: () => AsyncGenerator<unknown> = async function* () {
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

describe('createReplSession ToolUseContext population (P3-T0)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p3-tuc-'))

  beforeEach(() => {
    capturedQueryCalls.length = 0
    mockQueryImpl = async function* () {
      yield { type: 'result' }
    }
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes non-empty toolUseContext to vendor query()', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    await session.submit([{ type: 'text', text: 'list /tmp' }])

    expect(capturedQueryCalls).toHaveLength(1)
    const ctx = capturedQueryCalls[0]!.toolUseContext
    expect(ctx).toBeDefined()
    expect(ctx).not.toBeNull()
    // The pre-fix bug was `toolUseContext: {} as any` — must NOT be empty.
    expect(Object.keys(ctx).length).toBeGreaterThan(0)

    await session.dispose()
  })

  it('toolUseContext.options contains a tools field (LLM needs to see tools)', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    await session.submit([{ type: 'text', text: 'go' }])

    const opts = capturedQueryCalls[0]!.toolUseContext.options
    expect(opts).toBeDefined()
    expect(opts.tools).toBeDefined()
    // tools is a Tools map keyed by tool name. It must be a non-null
    // object (even if empty when no host overrides are supplied).
    expect(typeof opts.tools).toBe('object')

    await session.dispose()
  })

  it('toolUseContext.options.commands is an array (even when empty)', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    await session.submit([{ type: 'text', text: 'go' }])

    const opts = capturedQueryCalls[0]!.toolUseContext.options
    expect(Array.isArray(opts.commands)).toBe(true)

    await session.dispose()
  })

  it('toolUseContext has abortController, readFileState, and getAppState', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    await session.submit([{ type: 'text', text: 'go' }])

    const ctx = capturedQueryCalls[0]!.toolUseContext
    // abortController is required for cancellation; query() throws
    // without it.
    expect(ctx.abortController).toBeDefined()
    expect(ctx.abortController).toBeInstanceOf(AbortController)
    // readFileState and getAppState are read by query()/claude.ts.
    expect(ctx.readFileState).toBeDefined()
    expect(typeof ctx.getAppState).toBe('function')
    expect(typeof ctx.setAppState).toBe('function')

    await session.dispose()
  })

  it('toolUseContext honors host-supplied commands override', async () => {
    const hostCommands = [{ name: 'fake-cmd' }] as any
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
      commands: hostCommands,
    } as any)

    await session.submit([{ type: 'text', text: 'go' }])

    const opts = capturedQueryCalls[0]!.toolUseContext.options
    expect(opts.commands).toBe(hostCommands)

    await session.dispose()
  })

  it('toolUseContext honors host-supplied model override', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
      model: 'claude-test-host-model',
    } as any)

    await session.submit([{ type: 'text', text: 'go' }])

    const opts = capturedQueryCalls[0]!.toolUseContext.options
    expect(opts.mainLoopModel).toBe('claude-test-host-model')

    await session.dispose()
  })

  it('toolUseContext defaults mainLoopModel when host omits it', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    await session.submit([{ type: 'text', text: 'go' }])

    const opts = capturedQueryCalls[0]!.toolUseContext.options
    // Default falls back to a known string so vendor query() doesn't
    // throw on undefined mainLoopModel.
    expect(typeof opts.mainLoopModel).toBe('string')
    expect(opts.mainLoopModel.length).toBeGreaterThan(0)

    await session.dispose()
  })

  it('toolUseContext.options.mcpClients is an array (empty fallback)', async () => {
    const session = createReplSession({
      sessionId: `s-${randomUUID()}`,
      cwd: tmpDir,
      input: (async function* () {})(),
      hooks: { onEvent: () => {} },
    })

    await session.submit([{ type: 'text', text: 'go' }])

    const opts = capturedQueryCalls[0]!.toolUseContext.options
    expect(Array.isArray(opts.mcpClients)).toBe(true)

    await session.dispose()
  })
})