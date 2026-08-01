import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { installMacroStub } from '../../../src/compat/openccInit.js'

/**
 * Sub-agent callModel routing — zai compat
 *
 * The bundle's `query/deps.ts` `productionDeps()` returns a default deps
 * object used by every `query()` invocation that doesn't pass
 * `params.deps`. AgentTool's vendor `runAgent.ts` calls `query({...})`
 * without `params.deps`, so every sub-agent spawned via AgentTool goes
 * through `productionDeps()`. If `productionDeps()` returns vendor's
 * `queryModelWithStreaming` (a direct Anthropic call that bypasses zai's
 * model profile resolution + 2013 sanitizer + per-model config), the
 * sub-agent's call silently returns empty and the parent sees
 * "(Subagent completed but returned no output.)".
 *
 * The fix: `installMacroStub()` exposes
 * `globalThis.__zaiTranslateCallModel = translateCallModel` BEFORE the
 * bundle is loaded, and zai's `initAgentRuntime` sets
 * `globalThis.__zaiModelCaller = zaiModelCaller` afterwards.
 * `productionDeps()` then routes through these globals, so sub-agents
 * get the same call path as the parent's main loop.
 *
 * This test guards that the compat-side global is wired up. The
 * bundle-side `productionDeps()` consult is verified end-to-end by the
 * ego-browser integration: run a sub-agent via AgentTool, confirm
 * output is not "(Subagent completed but returned no output.)".
 */

describe('sub-agent callModel routing — zai compat', () => {
  let bundle: any
  let originalEnv: string | undefined
  let originalModelCaller: any
  let originalTranslate: any

  beforeAll(async () => {
    // Pin the same env-var defaults the production runtime uses.
    originalEnv = process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    installMacroStub()
    bundle = await import('@zn-ai/zn-agent-core/opencc-core')
    // Snapshot the globals so we can restore them after the test — the
    // vitest worker shares the global scope, and a parallel test that
    // doesn't expect these globals could be surprised.
    originalModelCaller = (globalThis as any).__zaiModelCaller
    originalTranslate = (globalThis as any).__zaiTranslateCallModel
  }, 30_000)

  afterAll(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    } else {
      process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = originalEnv
    }
    if (originalModelCaller === undefined) {
      delete (globalThis as any).__zaiModelCaller
    } else {
      ;(globalThis as any).__zaiModelCaller = originalModelCaller
    }
    if (originalTranslate === undefined) {
      delete (globalThis as any).__zaiTranslateCallModel
    } else {
      ;(globalThis as any).__zaiTranslateCallModel = originalTranslate
    }
  })

  it(
    'installMacroStub() exposes translateCallModel as globalThis.__zaiTranslateCallModel',
    { timeout: 10_000 },
    () => {
      const translate = (globalThis as any).__zaiTranslateCallModel
      expect(typeof translate).toBe('function')
    },
  )
})
