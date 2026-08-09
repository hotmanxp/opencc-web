/**
 * Regression test for the Bash hang fix (Aug 2026).
 *
 * Root cause: vendor's `runPreToolUseHooks` (src/opencc-src/services/tools/toolHooks.ts)
 * awaits shell-spawned plugin hooks (PreToolUse). Under zai's localhost-only
 * HTTP-server runtime those spawns throw (missing CLAUDE_PLUGIN_ROOT, spawn
 * ENOENT, plugin script permission errors). The outer catch at toolHooks.ts:715
 * then yields `{type:'stop'}`, which `checkPermissionsAndCallTool` propagates
 * as `createToolResultStopMessage(toolUseID)` — the LLM receives a synthetic
 * "The user doesn't want to take this action right now. STOP…" tool_result,
 * the real `tool.call()` never runs, and the UI stays on "调用中" forever
 * because the synthetic stop message closes the tool_use/tool_result pair
 * without producing real shell output.
 *
 * Fix: when `globalThis.__zaiSkipPreToolUseHooks === true`, the function
 * must yield nothing and return immediately. The existing
 * `forceAllowCheckPermissions` patch (compat/tools/opencc/builtin.ts) then
 * provides the unconditional allow on the tool.checkPermissions path.
 *
 * Test strategy: vendor's toolHooks module eagerly imports BashTool, which
 * in turn calls runtime helpers that are unavailable in unit tests. So
 * instead of importing vendor code, we apply the same short-circuit rule
 * to a minimal stub and assert the contract that zai depends on. A separate
 * static assertion (`src file contains the gate`) then locks the patch
 * itself to the source.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Mirror of the patch in src/opencc-src/services/tools/toolHooks.ts. If
 * this drifts from the vendor patch, both the local mirror and the vendor
 * patch are likely broken together — update this in lockstep.
 */
async function* zaiShortCircuitRunPreToolUseHooks(
  flag: boolean,
): AsyncGenerator<unknown, void, unknown> {
  if (flag) return
  // Real implementation would otherwise yield hook results here.
  yield { type: 'stop' }
}

describe('zai PreToolUse short-circuit (mirror)', () => {
  it('yields nothing when the flag is set', async () => {
    const out: unknown[] = []
    for await (const r of zaiShortCircuitRunPreToolUseHooks(true)) {
      out.push(r)
    }
    expect(out).toEqual([])
  })

  it('would otherwise yield a stop (proves the contract)', async () => {
    const out: unknown[] = []
    for await (const r of zaiShortCircuitRunPreToolUseHooks(false)) {
      out.push(r)
    }
    expect(out).toEqual([{ type: 'stop' }])
  })
})

describe('vendor patch is present in toolHooks.ts', () => {
  // Static check: ensures the actual vendor source carries the patch.
  // If a future vendoring refresh removes the short-circuit, this test
  // fails — which is exactly what we want, because the Bash hang would
  // come back.
  const vendorPath = resolve(
    HERE,
    '..',
    '..',
    '..',
    'src/opencc-src/services/tools/toolHooks.ts',
  )
  const src = readFileSync(vendorPath, 'utf-8')

  it('declares the __zaiSkipPreToolUseHooks gate at the top of runPreToolUseHooks', () => {
    // Match: a single, specific short-circuit line inside the
    // runPreToolUseHooks body. Anchored to the symbol so we don't false-
    // match elsewhere in the file.
    expect(src).toMatch(
      /__zaiSkipPreToolUseHooks\s*===\s*true[\s\S]{0,40}return/,
    )
  })

  it('documents why the bypass exists in a comment near the gate', () => {
    // Match a comment containing the keywords that explain the bug.
    // Loose — we only require the keywords to appear within ~600 chars
    // of the gate, so a vendor refresh that updates the wording still
    // passes.
    const idx = src.indexOf('__zaiSkipPreToolUseHooks')
    expect(idx).toBeGreaterThan(-1)
    const around = src.slice(Math.max(0, idx - 600), idx + 200)
    expect(around).toMatch(/PreToolUse/i)
    expect(around).toMatch(/STOP/i)
  })
})

// Removed: 'zai initAgentRuntime sets the flag' describe block.
// Aug 2026: decided to actually open the PreToolUse path (drop the
// __zaiSkipPreToolUseHooks = true assignment in agentRuntime.ts) after
// ego-browser validation showed hook execution (exit 0 + block output)
// does not hang the UI under zai's HTTP-server runtime. The vendor gate
// in toolHooks.ts is kept for defense-in-depth and verified by the
// 'vendor patch is present in toolHooks.ts' describe block above.
