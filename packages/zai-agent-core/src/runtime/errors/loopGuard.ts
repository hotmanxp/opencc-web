/**
 * A.3 Tool 死循环防护 (loopGuard).
 *
 * spec §2.1 / §2.4:
 * - recordToolFailure 第一次 → 'continue',连续 N 次同 toolUseId → 'break-and-error'
 * - recordToolSuccess → 清零该 toolUseId 计数
 * - 不同 toolUseId 之间计数独立
 * - 永不抛(spec §2.4)
 */

export interface LoopGuardState {
  consecutiveFailureByToolId: Map<string, number>
  /** default 3 (config.runtime.toolFailureLoopMaxConsecutive) */
  maxConsecutive?: number
}

export type LoopGuardDecision = 'continue' | 'break-and-error' | 'reset'

const DEFAULT_MAX_CONSECUTIVE = 3

function getMax(state: LoopGuardState): number {
  const m = state.maxConsecutive
  if (typeof m === 'number' && m >= 1) return m
  return DEFAULT_MAX_CONSECUTIVE
}

/**
 * Record a tool failure for the given toolUseId.
 * - 1st failure → 'continue'
 * - N-th consecutive failure → 'break-and-error'
 * Returns 'continue' for any count strictly below the threshold.
 */
export function recordToolFailure(
  state: LoopGuardState,
  toolUseId: string,
): LoopGuardDecision {
  try {
    if (!state || !state.consecutiveFailureByToolId || !toolUseId) {
      return 'continue'
    }
    const max = getMax(state)
    const prev = state.consecutiveFailureByToolId.get(toolUseId) ?? 0
    const next = prev + 1
    state.consecutiveFailureByToolId.set(toolUseId, next)
    return next >= max ? 'break-and-error' : 'continue'
  } catch {
    return 'continue'
  }
}

/**
 * Reset the failure counter for the given toolUseId.
 * Spec maps this to a 'reset' decision (the return value is informational;
 * the side effect is the actual reset).
 */
export function recordToolSuccess(
  state: LoopGuardState,
  toolUseId: string,
): void {
  try {
    if (!state || !state.consecutiveFailureByToolId || !toolUseId) return
    state.consecutiveFailureByToolId.set(toolUseId, 0)
  } catch {
    // 永不抛
  }
}