/**
 * C.3 — Stop-hook blocking (spec C §2.1).
 *
 * Wire-in stage (Phase 2 in queryLoop.ts) wraps
 * `HookRunner.run('Stop', { blocking: true, ... })` in a try/catch.
 * If the hook throws a `HookBlockedError`, we catch it and yield a
 * `runtime.error` with `kind:'hook_blocked'` plus `hookName` / `reason`
 * on the payload, then break out of the loop.
 *
 * Non-HookBlockedError throws are NOT treated as blocking (spec §3
 * 行为 9) — they bubble up the existing error path unchanged.
 */

/**
 * Marker interface for `Stop` hooks that want to actively block the
 * current turn. Spec C §2.1: pure additive payload extension.
 *
 * HookRunner.run('Stop', { ..., blocking: true }) receives this on
 * the input; hooks can inspect it to know whether they're allowed to
 * throw a blocking error.
 */
export interface StopHookPayload {
  /** Always present on Stop hook inputs. */
  blocking: boolean
}

/**
 * Thrown by a Stop hook to actively break the loop. Wire-in catches
 * this specifically and yields `runtime.error` with
 * `kind: 'hook_blocked'`.
 *
 * Non-HookBlockedError throws are passed through to the normal error
 * pipeline (see spec C §3 行为 9).
 */
export class HookBlockedError extends Error {
  public readonly hookName: string
  public readonly reason: string | undefined
  public readonly isHookBlocked: true = true

  constructor(hookName: string, reason?: string) {
    super(
      reason
        ? `Hook "${hookName}" blocked: ${reason}`
        : `Hook "${hookName}" blocked.`,
    )
    // Spec §4: name must be exactly 'HookBlockedError'.
    this.name = 'HookBlockedError'
    this.hookName = hookName
    this.reason = reason
    // Defensive: keep prototype chain consistent across transpilers.
    Object.setPrototypeOf(this, HookBlockedError.prototype)
  }
}

/**
 * Type guard — true iff `e` is a `HookBlockedError` (duck-typed so
 * cross-realm / serialized errors still match).
 */
export function isHookBlockedError(e: unknown): e is HookBlockedError {
  if (e instanceof HookBlockedError) return true
  if (!e || typeof e !== 'object') return false
  const obj = e as Record<string, unknown>
  if (obj['name'] !== 'HookBlockedError') return false
  if (typeof obj['hookName'] !== 'string') return false
  // Optional reason — if present, must be string.
  if (obj['reason'] !== undefined && typeof obj['reason'] !== 'string') {
    return false
  }
  return true
}

/**
 * Build the `runtime.error` payload that wire-in yields when a
 * `HookBlockedError` is caught. Pure; no side effects.
 *
 * The returned shape is loose-typed because `RuntimeEvent.error` is
 * intentionally open (`[key: string]: unknown`). The wire-in layer
 * enriches it with `eventId` / `sessionId` / `turnIndex` / `ts` via
 * wrapWithZaiMeta.
 *
 * Note: spec says ErrorKind union already contains 'hook_blocked' (A
 * Agent's domain). We don't import or depend on the ErrorKind type
 * here — the string literal is the contract.
 */
export interface HookBlockedErrorPayload {
  message: string
  fatal: boolean
  /** Discriminator — spec C §2.2 + A's ErrorKind union. */
  kind: 'hook_blocked'
  /** Always populated when kind='hook_blocked'. */
  hookName: string
  /** Optional human-readable reason. */
  reason: string | undefined
}

export function buildHookBlockedErrorPayload(
  err: HookBlockedError,
): HookBlockedErrorPayload {
  return {
    message: err.message,
    fatal: true,
    kind: 'hook_blocked',
    hookName: err.hookName,
    reason: err.reason,
  }
}