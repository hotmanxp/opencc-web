/**
 * Circuit breaker state + 状态机解析。
 *
 * 半开(half-open)状态:连续失败 ≥ MAX(3)后,允许 cooldown 后再试一次
 * (effectiveConsecutiveFailures = MAX-1),失败立刻 trip 回 open。
 *
 * 镜像 OpenCC `autoCompact.ts` 行为但完全独立实现。
 */

import type {
  AutoCompactTrackingState,
  CircuitBreakerAction,
} from './types.js'

export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
export const AUTOCOMPACT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000
export const MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS = 10_000

/**
 * 解析 env override,只接受 ≥ floor 的正整数,非法值回退默认。
 *
 * 防御:前导零 / 负数 / 科学计数 / 浮点 全部拒绝。
 */
export function getAutoCompactFailureCooldownMs(): number {
  const override = process.env.ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS
  if (!override) return AUTOCOMPACT_FAILURE_COOLDOWN_MS
  const trimmed = override.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) return AUTOCOMPACT_FAILURE_COOLDOWN_MS
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) return AUTOCOMPACT_FAILURE_COOLDOWN_MS
  if (parsed < MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS) return AUTOCOMPACT_FAILURE_COOLDOWN_MS
  return parsed
}

/**
 * 状态机:closed → (≥ 3 失败) → open → (cooldown 到期) → half-open → (成功) closed / (失败) open
 */
export function resolveAutoCompactCircuitBreakerState(args: {
  tracking?: Pick<AutoCompactTrackingState, 'consecutiveFailures' | 'nextRetryAtMs' | 'lastFailureAtMs'>
  nowMs: number
  cooldownMs: number
}): CircuitBreakerAction {
  const { tracking, nowMs, cooldownMs } = args
  const consecutiveFailures = Math.max(0, tracking?.consecutiveFailures ?? 0)

  if (consecutiveFailures < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return {
      action: 'allow',
      effectiveConsecutiveFailures: consecutiveFailures,
      wasHalfOpen: false,
    }
  }

  // ≥ 3 失败,进入 cooldown 检查
  let nextRetryAtMs = tracking?.nextRetryAtMs
  if (
    (typeof nextRetryAtMs !== 'number' || !Number.isFinite(nextRetryAtMs)) &&
    typeof tracking?.lastFailureAtMs === 'number' &&
    Number.isFinite(tracking.lastFailureAtMs) &&
    Number.isFinite(cooldownMs)
  ) {
    nextRetryAtMs = tracking.lastFailureAtMs + cooldownMs
  }

  if (
    typeof nextRetryAtMs === 'number' &&
    Number.isFinite(nextRetryAtMs) &&
    nowMs < nextRetryAtMs
  ) {
    return {
      action: 'skip',
      consecutiveFailures,
      nextRetryAtMs,
      circuitBreakerActive: true,
    }
  }

  // cooldown 已过,半开:用 MAX-1 让这次失败直接 trip
  return {
    action: 'allow',
    effectiveConsecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES - 1,
    wasHalfOpen: true,
  }
}