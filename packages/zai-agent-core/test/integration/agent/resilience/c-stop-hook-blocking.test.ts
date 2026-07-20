/**
 * 集成测试 — C.2 Stop-hook 阻断 (HookBlockedError).
 *
 * 覆盖 spec C §3 行为 8-10 + §4 的 4 个 case。
 *
 * Wire-in 阶段 (Phase 2, queryLoop.ts) 模拟 Stop hook 阻断的全链路。
 *
 * 测试目标:
 *   1. hook 抛 HookBlockedError → wire-in 产 runtime.error kind=hook_blocked, break loop
 *   2. hook 抛非 HookBlockedError → 不视为阻断, 走原错误路径(不静默吞)
 *   3. hook 正常返回 → 行为不变
 *   4. runtime.error payload 包含 hookName + reason
 *
 * Wire-in 实现说明:
 *   现有 HookRunner.run 会把 executor 异常吞到 result.errors[] 里,不重抛。
 *   按 C Agent 约束 ("HookRunner 不持有 HookBlockedError reference,
 *   阻断逻辑由主 session 在 Phase 2 接入"), wire-in 直接调 executor,
 *   让 HookBlockedError 沿 throw 路径上来。
 */
import { describe, test, expect } from 'vitest'
import {
  HookBlockedError,
  isHookBlockedError,
  buildHookBlockedErrorPayload,
} from '../../../../src/runtime/nudge/hooks.js'
import type { HookBlockedErrorPayload } from '../../../../src/runtime/nudge/hooks.js'
import { HookRunner } from '../../../../src/plugins/HookRunner.js'
import type { HookExecutor, PluginHook } from '../../../../src/plugins/types.js'

// ============================================================================
// Helper: simulate the wire-in block that lives in queryLoop.ts (Phase 2)
// ============================================================================

interface WireInOutcome {
  /** Yielded runtime.error payload (if any). */
  errorPayload?: HookBlockedErrorPayload
  /** Whether the wire-in decided to break out of the loop. */
  shouldBreak: boolean
  /** Whether a non-blocking error was re-thrown (per spec §3 行为 9). */
  rethrown: Error | null
}

/**
 * Mirror of the wire-in code that will live in queryLoop.ts:
 *
 *   for (const hook of stopHooks) {
 *     try {
 *       await executor({ command: hook.command, event: 'Stop',
 *                        pluginId: hook.pluginId, pluginRoot: hook.pluginRoot,
 *                        input: { blocking: true }, signal })
 *     } catch (e) {
 *       if (isHookBlockedError(e)) {
 *         const payload = buildHookBlockedErrorPayload(e)
 *         yield { type: 'runtime.error', payload }
 *         break  // exit loop
 *       }
 *       throw e  // re-raise so the outer error path handles it
 *     }
 *   }
 */
async function simulateWireInStopHook(
  hooks: PluginHook[],
  executor: HookExecutor,
  signal: AbortSignal,
): Promise<WireInOutcome> {
  const stopHooks = hooks.filter((h) => h.event === 'Stop')
  for (const hook of stopHooks) {
    try {
      await executor({
        command: hook.command,
        event: hook.event,
        pluginId: hook.pluginId,
        pluginRoot: hook.pluginRoot,
        input: { blocking: true },
        signal,
      })
    } catch (e) {
      if (isHookBlockedError(e)) {
        return {
          errorPayload: buildHookBlockedErrorPayload(e),
          shouldBreak: true,
          rethrown: null,
        }
      }
      // Non-HookBlockedError — wire-in must NOT swallow it.
      return {
        shouldBreak: false,
        rethrown: e instanceof Error ? e : new Error(String(e)),
      }
    }
  }
  return { shouldBreak: false, rethrown: null }
}

// ============================================================================
// HookBlockedError class behavior
// ============================================================================

describe('HookBlockedError (spec C §2.1, §4 case 1)', () => {
  test('HookBlockedError has name="HookBlockedError"', () => {
    const err = new HookBlockedError('my-stop-hook')
    expect(err.name).toBe('HookBlockedError')
  })

  test('HookBlockedError preserves hookName + reason fields', () => {
    const err = new HookBlockedError('my-stop-hook', 'user requested stop')
    expect(err.hookName).toBe('my-stop-hook')
    expect(err.reason).toBe('user requested stop')
    expect(err.message).toContain('my-stop-hook')
    expect(err.message).toContain('user requested stop')
  })

  test('HookBlockedError reason is optional', () => {
    const err = new HookBlockedError('my-stop-hook')
    expect(err.hookName).toBe('my-stop-hook')
    expect(err.reason).toBeUndefined()
    expect(err.message).toContain('my-stop-hook')
  })

  test('HookBlockedError extends Error and is instanceof Error', () => {
    const err = new HookBlockedError('h', 'r')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(HookBlockedError)
  })

  test('isHookBlockedError accepts real HookBlockedError', () => {
    const err = new HookBlockedError('h', 'r')
    expect(isHookBlockedError(err)).toBe(true)
  })

  test('isHookBlockedError accepts duck-typed object (cross-realm)', () => {
    // Simulate a deserialized error from another realm (e.g. worker)
    const duck = Object.assign(new Error('Hook "h" blocked: r'), {
      name: 'HookBlockedError',
      hookName: 'h',
      reason: 'r',
      isHookBlocked: true,
    })
    expect(isHookBlockedError(duck)).toBe(true)
  })

  test('isHookBlockedError rejects plain Error', () => {
    expect(isHookBlockedError(new Error('boom'))).toBe(false)
  })

  test('isHookBlockedError rejects TypeError / RangeError', () => {
    expect(isHookBlockedError(new TypeError('t'))).toBe(false)
    expect(isHookBlockedError(new RangeError('r'))).toBe(false)
  })

  test('isHookBlockedError rejects null / undefined / string / number', () => {
    expect(isHookBlockedError(null)).toBe(false)
    expect(isHookBlockedError(undefined)).toBe(false)
    expect(isHookBlockedError('HookBlockedError')).toBe(false)
    expect(isHookBlockedError(42)).toBe(false)
  })

  test('isHookBlockedError rejects object with wrong name', () => {
    expect(isHookBlockedError({ name: 'OtherError', hookName: 'h' })).toBe(false)
  })

  test('isHookBlockedError rejects object with non-string hookName', () => {
    expect(isHookBlockedError({ name: 'HookBlockedError', hookName: 42 })).toBe(false)
  })

  test('isHookBlockedError rejects object with non-string reason', () => {
    expect(
      isHookBlockedError({
        name: 'HookBlockedError',
        hookName: 'h',
        reason: 42,
      }),
    ).toBe(false)
  })

  // ---- buildHookBlockedErrorPayload ----

  test('buildHookBlockedErrorPayload emits kind=hook_blocked + hookName + reason', () => {
    const err = new HookBlockedError('my-stop-hook', 'manual stop')
    const payload = buildHookBlockedErrorPayload(err)
    expect(payload.kind).toBe('hook_blocked')
    expect(payload.hookName).toBe('my-stop-hook')
    expect(payload.reason).toBe('manual stop')
    expect(payload.fatal).toBe(true)
    expect(payload.message).toContain('my-stop-hook')
  })

  test('buildHookBlockedErrorPayload reason=undefined when not provided', () => {
    const err = new HookBlockedError('h')
    const payload = buildHookBlockedErrorPayload(err)
    expect(payload.kind).toBe('hook_blocked')
    expect(payload.hookName).toBe('h')
    expect(payload.reason).toBeUndefined()
  })
})

// ============================================================================
// §3 行为 8: wire-in catches HookBlockedError → runtime.error + break
// ============================================================================

describe('wire-in Stop hook (spec C §3 行为 8-10)', () => {
  test('wire-in: hook throws HookBlockedError → runtime.error kind=hook_blocked, shouldBreak=true', async () => {
    const stopHook: PluginHook = {
      event: 'Stop',
      pluginId: 'test-plugin',
      pluginRoot: '/tmp/test',
      command: 'noop',
    }
    const executor: HookExecutor = async () => {
      throw new HookBlockedError('my-stop-hook', 'user cancel')
    }
    const outcome = await simulateWireInStopHook(
      [stopHook],
      executor,
      new AbortController().signal,
    )
    expect(outcome.shouldBreak).toBe(true)
    expect(outcome.errorPayload).toBeDefined()
    expect(outcome.errorPayload?.kind).toBe('hook_blocked')
    expect(outcome.errorPayload?.hookName).toBe('my-stop-hook')
    expect(outcome.errorPayload?.reason).toBe('user cancel')
    expect(outcome.rethrown).toBeNull()
  })

  // ---- §3 行为 9: non-HookBlockedError is NOT treated as blocking ----

  test('wire-in: hook throws plain Error → does NOT break, re-raises to outer pipeline', async () => {
    const stopHook: PluginHook = {
      event: 'Stop',
      pluginId: 'test-plugin',
      pluginRoot: '/tmp/test',
      command: 'noop',
    }
    const boom = new Error('hook exec failed')
    const executor: HookExecutor = async () => {
      throw boom
    }
    const outcome = await simulateWireInStopHook(
      [stopHook],
      executor,
      new AbortController().signal,
    )
    expect(outcome.shouldBreak).toBe(false)
    expect(outcome.errorPayload).toBeUndefined()
    expect(outcome.rethrown).toBe(boom)
  })

  test('wire-in: hook throws TypeError → does NOT break, re-raises', async () => {
    const stopHook: PluginHook = {
      event: 'Stop',
      pluginId: 'test-plugin',
      pluginRoot: '/tmp/test',
      command: 'noop',
    }
    const executor: HookExecutor = async () => {
      throw new TypeError('bad input')
    }
    const outcome = await simulateWireInStopHook(
      [stopHook],
      executor,
      new AbortController().signal,
    )
    expect(outcome.shouldBreak).toBe(false)
    expect(outcome.rethrown).toBeInstanceOf(TypeError)
  })

  test('wire-in: no Stop hooks registered → no-op, no break', async () => {
    const preToolHook: PluginHook = {
      event: 'PreToolUse',
      pluginId: 'test-plugin',
      pluginRoot: '/tmp/test',
      command: 'noop',
    }
    const executor: HookExecutor = async () => ({ output: 'pretool' })
    const outcome = await simulateWireInStopHook(
      [preToolHook],
      executor,
      new AbortController().signal,
    )
    expect(outcome.shouldBreak).toBe(false)
    expect(outcome.errorPayload).toBeUndefined()
    expect(outcome.rethrown).toBeNull()
  })

  // ---- §3 行为 10: hook returns normally → no behavior change ----

  test('wire-in: hook returns normally → shouldBreak=false, no error payload', async () => {
    const stopHook: PluginHook = {
      event: 'Stop',
      pluginId: 'test-plugin',
      pluginRoot: '/tmp/test',
      command: 'noop',
    }
    const executor: HookExecutor = async () => ({ output: 'ok' })
    const outcome = await simulateWireInStopHook(
      [stopHook],
      executor,
      new AbortController().signal,
    )
    expect(outcome.shouldBreak).toBe(false)
    expect(outcome.errorPayload).toBeUndefined()
    expect(outcome.rethrown).toBeNull()
  })

  // ---- §4 第 4 case: runtime.error payload 包含 hookName + reason ----

  test('runtime.error payload faithfully carries hookName and reason from throw', () => {
    const cases: Array<[string, string | undefined]> = [
      ['plugin-a', 'rate limit exceeded'],
      ['plugin-b', undefined],
      ['plugin-c', ''],
      ['plugin-d', 'user typed /stop'],
    ]
    for (const [hookName, reason] of cases) {
      const err = new HookBlockedError(hookName, reason)
      const payload = buildHookBlockedErrorPayload(err)
      expect(payload.hookName).toBe(hookName)
      // Empty-string reason should pass through as empty string (not undefined)
      if (reason === undefined) {
        expect(payload.reason).toBeUndefined()
      } else {
        expect(payload.reason).toBe(reason)
      }
    }
  })
})

// ============================================================================
// HookRunner additive extension verification (spec C §2.1, §3 行为 8)
// ============================================================================

describe('HookRunner additive extension (spec C §2.1)', () => {
  test('HookRunner forwards StopHookPayload.input verbatim — includes blocking:true', async () => {
    let capturedInput: unknown = undefined
    const stopHook: PluginHook = {
      event: 'Stop',
      pluginId: 'test-plugin',
      pluginRoot: '/tmp/test',
      command: 'noop',
    }
    const executor: HookExecutor = async ({ input }) => {
      capturedInput = input
      return { output: 'ok' }
    }
    const runner = new HookRunner([stopHook], executor)
    const stopPayload = { blocking: true, sessionId: 'sess-1' }
    await runner.run('Stop', stopPayload, new AbortController().signal)
    expect(capturedInput).toEqual(stopPayload)
  })

  test('HookRunner.run with no matching Stop hook → ran=0, blocked=false', async () => {
    const nonMatchingHook: PluginHook = {
      event: 'PreToolUse',
      pluginId: 'test-plugin',
      pluginRoot: '/tmp/test',
      command: 'noop',
    }
    const executor: HookExecutor = async () => ({ output: 'pretool' })
    const runner = new HookRunner([nonMatchingHook], executor)
    const result = await runner.run(
      'Stop',
      { blocking: true },
      new AbortController().signal,
    )
    expect(result.ran).toBe(0)
    expect(result.blocked).toBe(false)
  })

  test('HookRunner swallows HookBlockedError into result.errors (current behavior — Phase 2 must use executor directly)', async () => {
    // Documents the existing behavior: HookRunner.run captures executor
    // throws into result.errors[]. Wire-in must therefore call the
    // executor directly to receive the HookBlockedError as a thrown
    // exception. This is a documented contract, not a regression.
    const stopHook: PluginHook = {
      event: 'Stop',
      pluginId: 'test-plugin',
      pluginRoot: '/tmp/test',
      command: 'noop',
    }
    const executor: HookExecutor = async () => {
      throw new HookBlockedError('user-cancel-hook', 'esc pressed')
    }
    const runner = new HookRunner([stopHook], executor)
    // runner.run does NOT throw — it captures into result.errors
    const result = await runner.run(
      'Stop',
      { blocking: true },
      new AbortController().signal,
    )
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]?.code).toBe('hook_executor_error')
  })

  test('HookBlockedError thrown from executor can be caught via direct executor call', async () => {
    // Mirror of the actual wire-in pattern: bypass HookRunner.run,
    // call executor directly so the throw bubbles up.
    const stopHook: PluginHook = {
      event: 'Stop',
      pluginId: 'test-plugin',
      pluginRoot: '/tmp/test',
      command: 'noop',
    }
    const executor: HookExecutor = async () => {
      throw new HookBlockedError('user-cancel-hook', 'esc pressed')
    }

    let caught: unknown = undefined
    try {
      await executor({
        command: stopHook.command,
        event: stopHook.event,
        pluginId: stopHook.pluginId,
        pluginRoot: stopHook.pluginRoot,
        input: { blocking: true },
        signal: new AbortController().signal,
      })
    } catch (e) {
      caught = e
    }
    expect(isHookBlockedError(caught)).toBe(true)
    if (isHookBlockedError(caught)) {
      expect(caught.hookName).toBe('user-cancel-hook')
      expect(caught.reason).toBe('esc pressed')
    }
  })
})