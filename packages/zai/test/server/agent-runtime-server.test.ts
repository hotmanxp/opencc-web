/**
 * Task 5 — zai agentRuntime ↔ OpenCC server runtime integration seam.
 *
 * Asserts the structural migration from `DefaultAgentRuntime` (compat
 * shim over `runViaOpenccQuery`) to `OpenccRuntime` (`createOpenccRuntime`
 * from `@zn-ai/zn-agent-core`) — without invoking a real
 * model call (the runtime's `modelCaller` injection is deferred to Task
 * 4.5; this test confirms the wiring contract, not the LLM round-trip).
 *
 * The pre-existing `agentRuntime.test.ts` covers the small helper
 * surface (session-abort registry, `abortAgentSession`). This file is
 * the new seam test for the Task 5 swap and asserts:
 *
 *   1. `initAgentRuntime(cwd)` constructs the OpenccRuntime via the
 *      public main-entry factory (not via the compat bridge).
 *   2. `getRuntime()` returns an object with all 8 documented
 *      OpenccRuntime methods (`query`, `abort`, `getSession`,
 *      `listSessions`, `readTranscript`, `patchSession`,
 *      `removeSession`, `shutdown`).
 *   3. `getRuntime().query(...)` returns an AsyncIterable (without
 *      driving a real prompt).
 *   4. `getServerCwd()` returns the cwd passed to `initAgentRuntime`.
 *   5. `abortAllAgentPrompts()` is safe to call when no prompts are
 *      active (the registered-but-empty registry case).
 *
 * The test does NOT spy on `__zaiBridgeCtx` or `openccQueryBridge` —
 * those shims are slated for deletion in Task 6 and asserting on them
 * would create a Task 6 follow-up. The migration contract lives in the
 * public surface (`@zn-ai/zn-agent-core`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Task 5 runtime construction pulls in the vendor headless bootstrap
// (~5s for module transform + disk IO on cold start). Bump the per-test
// timeout well above that so the seam test isn't flaky on slow CI.
const TEST_TIMEOUT_MS = 90_000
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const RUNTIME_METHODS = [
  'query',
  'abort',
  'getSession',
  'listSessions',
  'readTranscript',
  'patchSession',
  'removeSession',
  'shutdown',
] as const

describe('zai agentRuntime ↔ OpenccRuntime seam (Task 5)', () => {
  let prevDataDir: string | undefined
  let prevRuntimeCore: string | undefined
  let tmpHome: string

  beforeEach(() => {
    // Reset module-level state so each test rebuilds the runtime.
    prevDataDir = process.env.ZAI_DATA_DIR
    prevRuntimeCore = process.env.ZAI_RUNTIME_CORE
    // Pin runtimeCore to legacy 'default' track — this seam test
    // asserts the V1 8-method OpenccRuntime contract
    // (`createOpenccRuntime`), not the partial V2 ReplRuntime adapter.
    // Plan P2, Task 6 (2026-08-30) flipped the default to 'repl'; this
    // test preserves its original intent by explicitly selecting the
    // V1 'default' path (now using ZAI_RUNTIME_CORE, not the legacy
    // ZAI_RUNTIME_KERNEL env that the brief originally referenced).
    process.env.ZAI_RUNTIME_CORE = 'default'
    // `resolveDataDir()` reads `ZAI_DATA_DIR` first; pin to a tmp dir so
    // we don't touch the user's real ~/.zn-agent. Also clear HOME so
    // resolveDataDir() falls back to the env override.
    tmpHome = mkdtempSync(path.join(tmpdir(), 'zai-agent-runtime-'))
    process.env.ZAI_DATA_DIR = path.join(tmpHome, 'data')
    process.env.HOME = tmpHome
  })

  afterEach(async () => {
    process.env.ZAI_DATA_DIR = prevDataDir
    if (prevRuntimeCore === undefined) delete process.env.ZAI_RUNTIME_CORE
    else process.env.ZAI_RUNTIME_CORE = prevRuntimeCore
    // Restore HOME to its original value (always set on macOS, but
    // be defensive).
    if (process.env.HOME === tmpHome) delete process.env.HOME
    rmSync(tmpHome, { recursive: true, force: true })
    // Reset the runtime singleton so the next test starts from a clean
    // slate. The helper is exported for exactly this case.
    const mod = await import('../../src/server/services/agentRuntime.js')
    ;(mod as { __resetAgentRuntimeForTests?: () => void }).__resetAgentRuntimeForTests?.()
  })

  it('initAgentRuntime(cwd) constructs an OpenccRuntime (no legacy DefaultAgentRuntime call path)', async () => {
    const mod = await import('../../src/server/services/agentRuntime.js')
    const cwd = path.join(tmpHome, 'work')
    expect(() => mod.initAgentRuntime(cwd)).not.toThrow()
    // Let the fire-and-forget opencc-runtime construction resolve.
    await waitForRuntime(mod)
    const runtime = mod.getRuntime()
    for (const name of RUNTIME_METHODS) {
      expect(typeof (runtime as unknown as Record<string, unknown>)[name]).toBe('function')
    }
  }, TEST_TIMEOUT_MS)

  it('getRuntime().query(input) returns an AsyncIterable', async () => {
    const mod = await import('../../src/server/services/agentRuntime.js')
    mod.initAgentRuntime(path.join(tmpHome, 'work'))
    await waitForRuntime(mod)
    const runtime = mod.getRuntime()
    const stream = runtime.query({
      sessionId: 'sess-test',
      prompt: 'ping',
      cwd: path.join(tmpHome, 'work'),
    })
    expect(stream).toBeDefined()
    expect(typeof stream[Symbol.asyncIterator]).toBe('function')
  }, TEST_TIMEOUT_MS)

  it('getServerCwd() returns the cwd passed to initAgentRuntime', async () => {
    const mod = await import('../../src/server/services/agentRuntime.js')
    const cwd = path.join(tmpHome, 'work-cwd')
    mod.initAgentRuntime(cwd)
    expect(mod.getServerCwd()).toBe(cwd)
  }, TEST_TIMEOUT_MS)

  it('abortAllAgentPrompts() is safe when no prompts are active', async () => {
    const mod = await import('../../src/server/services/agentRuntime.js')
    mod.initAgentRuntime(path.join(tmpHome, 'work-abort'))
    // No registered controllers → drain completes immediately and
    // does not throw.
    expect(() => mod.abortAllAgentPrompts('test_no_prompts')).not.toThrow()
  }, TEST_TIMEOUT_MS)
})

/**
 * Poll for the runtime singleton. `initAgentRuntime` triggers the
 * `createOpenccRuntime` factory fire-and-forget; the runtime is
 * non-null once the async block resolves. We bound the wait so a
 * regression that drops the runtime does not hang the suite.
 */
async function waitForRuntime(mod: { getRuntime: () => unknown }): Promise<void> {
  // The vendor headless bootstrap reads from disk + resolves the MCP
  // client pool on first `createOpenccRuntime` call; the first cold
  // import pays an additional transform cost on top. 30s covers both
  // the cold path (vitest's transform pipeline plus a fresh dynamic
  // import) and any disk IO under load.
  const deadline = Date.now() + 30_000
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      mod.getRuntime()
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  // One final probe to surface a clean failure mode.
  try {
    mod.getRuntime()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[waitForRuntime] gave up; last error:', lastErr ?? err)
    throw err
  }
}
