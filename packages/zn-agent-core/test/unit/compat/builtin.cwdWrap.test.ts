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
 *     `runWithSessionId` is also mocked to be a no-op pass-through so
 *     zai's runQueryLoop wrapper doesn't pollute the ALS context.
 *   - `runWithSdkContext` + `getSdkContext` (vendor bootstrap/state.ts):
 *     used as-is — real AsyncLocalStorage semantics are exactly what
 *     we want to test. The mock BashTool calls `getSdkContext()` to
 *     read the active ctx and mutates ctx.cwd to simulate the vendor
 *     trailer side-effect (setCwdState mutates ctx.cwd in place).
 *   - BashTool itself is a plain stub — we never invoke the real
 *     vendor BashTool because doing so pulls the heavy tool chain
 *     (BashTool.tsx → Shell.ts → bashProvider.ts → ripgrep vendor,
 *     etc.) which has pre-existing vitest ESM breakages. The wrap
 *     contract under test is the cwd flow, not bash execution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CwdStore } from '../../../src/compat/cwdStore.js'

let mockSessionId: string | null = null
let activeCtx: { cwd: string; originalCwd: string; sessionId: string; sessionProjectDir: string | null } | null = null

vi.mock('../../../src/compat/runWithSessionId.js', () => ({
  getCurrentSessionId: () => mockSessionId,
  runWithSessionId: <T>(_sid: string, fn: () => T): T => fn(),
}))

// vitest's vi.mock intercepts by resolved module id. The compat
// layer wraps vendor state.js via the `src/...` bare specifier
// alias (see zn-agent-core/vitest.config.ts resolve.alias
// `find: /^src\/(.+)\.js$/`). We stub the module so builtin.ts
// can import it without dragging in the heavy vendor chain
// (Shell.ts → bashProvider.ts → ripgrep vendor etc.). The stub
// mirrors the two surface symbols we need: runWithSdkContext
// (single-slot pseudo-ALS for closure semantics) + getSdkContext.
vi.mock('src/bootstrap/state.js', () => ({
  runWithSdkContext: <T>(ctx: typeof activeCtx & object, fn: () => T): T => {
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

interface MockBashOpts {
  /**
   * Called inside the wrap's runWithSdkContext closure. Can mutate
   * the active ctx.cwd to simulate the vendor trailer side-effect
   * (setCwdState in opencc-src/utils/Shell.ts:425-440).
   */
  onCall?: (input: unknown, ctx: typeof activeCtx) => void
  onCallThrow?: Error
}

function mkBashTool(opts: MockBashOpts = {}) {
  const originalCall = vi.fn(
    async (input: unknown, _toolUseContext: unknown) => {
      // The stubbed runWithSdkContext sets activeCtx before invoking
      // originalCall; we mirror that lookup here.
      if (opts.onCall) opts.onCall(input, activeCtx)
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
        // Even if a real vendor trailer would mutate ctx.cwd, the
        // wrap shouldn't write when sid is missing.
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
    // Simulate vendor `Shell.ts:425` guard: setCwdState never fires,
    // ctx.cwd stays at beforeCwd.
    const tool = mkBashTool({ onCall: () => undefined })
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
    })
    const wrapped = wrapBashToolWithCwdSync(tool)
    await expect(wrapped.call({ command: 'bad' }, {} as never)).rejects.toThrow(
      'bash spawn failed',
    )
    expect(CwdStore.has('sid-1')).toBe(false)
  })
})
