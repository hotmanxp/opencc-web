/**
 * zai patch (2026-09-14, cwd-multi-session-persistence):
 * Unit tests for wrapBashToolWithCwdSync in
 * packages/zn-agent-core/src/compat/tools/opencc/builtin.ts.
 *
 * The wrap takes vendor BashTool and adds a per-session cwd sync
 * layer on top: read CwdStore[sid] (or process.cwd() fallback) as
 * beforeCwd, run the original call inside runWithSdkContext({ cwd:
 * beforeCwd }), then write ctx.cwd back to CwdStore if it changed.
 *
 * Mocking strategy:
 *   - `getCurrentSessionId` (compat/runWithSessionId.ts): replaced with
 *     a controlled `mockSessionId` so each test can stage a known sid.
 *   - `runWithSdkContext` + `getSdkContext` (vendor bootstrap/state.ts):
 *     replaced with a single-slot pseudo-ALS that mirrors vendor's
 *     "innermost ALS wins" semantics closely enough for the wrap
 *     contract. The wrap captures the ctx object by reference; the
 *     mock BashTool mutates ctx.cwd to simulate the vendor trailer
 *     side-effect, and the wrap reads it back post-call.
 *   - BashTool itself is a plain stub — we never invoke the real
 *     vendor BashTool because doing so pulls the heavy tool chain
 *     (BashTool.tsx → Shell.ts → bashProvider.ts → ripgrep vendor,
 *     etc.) which has pre-existing vitest ESM breakages. The wrap
 *     contract under test is the cwd flow, not bash execution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockSessionId: string | null = null
let activeCtx: { cwd: string; originalCwd: string; sessionId: string; sessionProjectDir: string | null } | null = null

vi.mock('../../../src/compat/runWithSessionId.js', () => ({
  getCurrentSessionId: () => mockSessionId,
  runWithSessionId: <T>(_sid: string, fn: () => T): T => fn(),
}))

vi.mock('../../../src/opencc-src/bootstrap/state.js', () => ({
  runWithSdkContext: <T>(ctx: typeof activeCtx & object, fn: () => T): T => {
    // Single-slot pseudo-ALS: only the most recent ctx is "active".
    // Nested runWithSdkContext unwinds in LIFO order via prev/activeCtx.
    const prev = activeCtx
    activeCtx = ctx as typeof activeCtx
    try {
      return fn()
    } finally {
      activeCtx = prev
    }
  },
  getSdkContext: () => activeCtx,
}))

const { wrapBashToolWithCwdSync } = await import(
  '../../../src/compat/tools/opencc/builtin.js'
)
const { CwdStore } = await import('../../../src/compat/cwdStore.js')

interface MockBashOpts {
  /** Called inside the wrap's runWithSdkContext closure. Can mutate ctx.cwd to simulate vendor trailer side-effect. */
  onCall?: (input: unknown, ctx: typeof activeCtx) => void
  onCallThrow?: Error
}

function mkBashTool(opts: MockBashOpts = {}) {
  const originalCall = vi.fn(
    async (input: unknown, _toolUseContext: unknown) => {
      // Read the active ctx (mock) — simulates vendor's
      // sdkStorage.getStore() inside Shell.exec → setCwdState path.
      const ctx = activeCtx
      if (ctx && opts.onCall) opts.onCall(input, ctx)
      if (opts.onCallThrow) throw opts.onCallThrow
      return { ok: true, stdout: '', stderr: '' }
    },
  )
  return {
    name: 'Bash',
    description: 'mock bash tool',
    inputSchema: {},
    call: originalCall,
  }
}

describe('wrapBashToolWithCwdSync', () => {
  beforeEach(() => {
    CwdStore.clear()
    mockSessionId = null
    activeCtx = null
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('no sessionId → calls originalCall directly, no CwdStore write', async () => {
    mockSessionId = null
    const tool = mkBashTool({
      onCall: (_input, ctx) => {
        if (ctx) ctx.cwd = '/should-not-be-written'
      },
    })
    const wrapped = wrapBashToolWithCwdSync(tool)
    await wrapped.call({ command: 'ls' }, {} as never)
    expect(tool.call).toHaveBeenCalledOnce()
    expect(CwdStore.size()).toBe(0)
  })

  it('first call: writes CwdStore when ctx.cwd changes (turn 1 cd /tmp)', async () => {
    mockSessionId = 'sid-1'
    const tool = mkBashTool({
      onCall: (_input, ctx) => {
        if (ctx) ctx.cwd = '/tmp'
      },
    })
    const wrapped = wrapBashToolWithCwdSync(tool)
    await wrapped.call({ command: 'cd /tmp' }, {} as never)
    expect(CwdStore.get('sid-1')).toBe('/tmp')
  })

  it('no write when ctx.cwd unchanged (preventCwdChanges / background bash simulation)', async () => {
    mockSessionId = 'sid-1'
    CwdStore.set('sid-1', '/already-set')
    const tool = mkBashTool({
      // Simulate vendor `Shell.ts:425` guard: setCwdState never fires,
      // ctx.cwd stays at beforeCwd.
      onCall: () => undefined,
    })
    const wrapped = wrapBashToolWithCwdSync(tool)
    await wrapped.call({ command: 'pwd' }, {} as never)
    expect(CwdStore.get('sid-1')).toBe('/already-set')
  })

  it('uses pre-existing CwdStore value as beforeCwd (cross-turn continuation)', async () => {
    mockSessionId = 'sid-1'
    CwdStore.set('sid-1', '/existing')
    let capturedBeforeCwd: string | undefined
    const tool = mkBashTool({
      onCall: (_input, ctx) => {
        capturedBeforeCwd = ctx?.cwd
        if (ctx) ctx.cwd = '/existing/sub'
      },
    })
    const wrapped = wrapBashToolWithCwdSync(tool)
    await wrapped.call({ command: 'cd sub' }, {} as never)
    expect(capturedBeforeCwd).toBe('/existing')
    expect(CwdStore.get('sid-1')).toBe('/existing/sub')
  })

  it('CwdStore miss → falls back to process.cwd()', async () => {
    mockSessionId = 'sid-2'
    let capturedBeforeCwd: string | undefined
    const tool = mkBashTool({
      onCall: (_input, ctx) => {
        capturedBeforeCwd = ctx?.cwd
      },
    })
    const wrapped = wrapBashToolWithCwdSync(tool)
    await wrapped.call({ command: 'pwd' }, {} as never)
    expect(capturedBeforeCwd).toBe(process.cwd())
    expect(CwdStore.has('sid-2')).toBe(false)
  })

  it('session isolation: two sessions tracked independently', async () => {
    // Sequential — vendor runs tool_use serially within a turn, but
    // simulates the multi-session case where each runQueryLoop has its
    // own compat ALS sid.
    mockSessionId = 'sid-A'
    const toolA = mkBashTool({
      onCall: (_input, ctx) => {
        if (ctx) ctx.cwd = '/A'
      },
    })
    const wrappedA = wrapBashToolWithCwdSync(toolA)
    await wrappedA.call({ command: 'cd /A' }, {} as never)

    mockSessionId = 'sid-B'
    const toolB = mkBashTool({
      onCall: (_input, ctx) => {
        if (ctx) ctx.cwd = '/B'
      },
    })
    const wrappedB = wrapBashToolWithCwdSync(toolB)
    await wrappedB.call({ command: 'cd /B' }, {} as never)

    expect(CwdStore.get('sid-A')).toBe('/A')
    expect(CwdStore.get('sid-B')).toBe('/B')
    expect(CwdStore.size()).toBe(2)
  })

  it('passes all extra args (toolUseContext, canUseTool, parentMessage, onProgress) to originalCall', async () => {
    mockSessionId = 'sid-1'
    const tool = mkBashTool()
    const wrapped = wrapBashToolWithCwdSync(tool)
    const toolUseContext = { sessionId: 'sid-1', toolUseId: 'tu-1' }
    const canUseTool = vi.fn()
    const parentMessage = { role: 'assistant' as const }
    const onProgress = vi.fn()
    await wrapped.call(
      { command: 'pwd' } as never,
      toolUseContext as never,
      canUseTool as never,
      parentMessage as never,
      onProgress as never,
    )
    expect(tool.call).toHaveBeenCalledWith(
      { command: 'pwd' },
      toolUseContext,
      canUseTool,
      parentMessage,
      onProgress,
    )
  })

  it('originalCall throw propagates and CwdStore is not written', async () => {
    mockSessionId = 'sid-1'
    const tool = mkBashTool({
      onCallThrow: new Error('bash spawn failed'),
      // ctx.cwd would normally be mutated by trailer, but throw
      // happens before trailer reads tmpfile.
      onCall: undefined,
    })
    const wrapped = wrapBashToolWithCwdSync(tool)
    await expect(wrapped.call({ command: 'bad' }, {} as never)).rejects.toThrow(
      'bash spawn failed',
    )
    expect(CwdStore.has('sid-1')).toBe(false)
  })
})
