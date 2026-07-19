import { describe, test, expect, afterEach } from 'vitest'
import {
  resolveAutoCompactCircuitBreakerState,
  getAutoCompactFailureCooldownMs,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  AUTOCOMPACT_FAILURE_COOLDOWN_MS,
  MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS,
} from '../../../src/runtime/compact/tracking.js'

describe('tracking (circuit breaker)', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('consecutiveFailures < 3 → allow, effectiveConsecutiveFailures = N', () => {
    const result = resolveAutoCompactCircuitBreakerState({
      tracking: { consecutiveFailures: 2 },
      nowMs: 1000,
      cooldownMs: 300_000,
    })
    expect(result.action).toBe('allow')
    if (result.action === 'allow') {
      expect(result.effectiveConsecutiveFailures).toBe(2)
      expect(result.wasHalfOpen).toBe(false)
    }
  })

  test('consecutiveFailures = 0(未指定) → allow, effectiveConsecutiveFailures = 0', () => {
    const result = resolveAutoCompactCircuitBreakerState({
      nowMs: 1000,
      cooldownMs: 300_000,
    })
    expect(result.action).toBe('allow')
    if (result.action === 'allow') {
      expect(result.effectiveConsecutiveFailures).toBe(0)
      expect(result.wasHalfOpen).toBe(false)
    }
  })

  test('consecutiveFailures = 3 + now < nextRetryAtMs → skip', () => {
    const result = resolveAutoCompactCircuitBreakerState({
      tracking: { consecutiveFailures: 3, nextRetryAtMs: 5000 },
      nowMs: 1000,
      cooldownMs: 300_000,
    })
    expect(result.action).toBe('skip')
    if (result.action === 'skip') {
      expect(result.consecutiveFailures).toBe(3)
      expect(result.nextRetryAtMs).toBe(5000)
      expect(result.circuitBreakerActive).toBe(true)
    }
  })

  test('consecutiveFailures = 3 + nextRetryAtMs 缺失 + lastFailureAtMs 存在 → 用 lastFailure + cooldown 计算 nextRetryAtMs', () => {
    const lastFailureAtMs = 1000
    const cooldownMs = 300_000
    const result = resolveAutoCompactCircuitBreakerState({
      tracking: { consecutiveFailures: 3, lastFailureAtMs },
      nowMs: lastFailureAtMs + 100,  // 100ms 后,远小于 cooldown
      cooldownMs,
    })
    expect(result.action).toBe('skip')
    if (result.action === 'skip') {
      expect(result.nextRetryAtMs).toBe(lastFailureAtMs + cooldownMs)
    }
  })

  test('consecutiveFailures = 3 + now >= nextRetryAtMs → allow, wasHalfOpen = true', () => {
    const result = resolveAutoCompactCircuitBreakerState({
      tracking: { consecutiveFailures: 3, nextRetryAtMs: 1000 },
      nowMs: 2000,
      cooldownMs: 300_000,
    })
    expect(result.action).toBe('allow')
    if (result.action === 'allow') {
      expect(result.effectiveConsecutiveFailures).toBe(2)  // MAX - 1
      expect(result.wasHalfOpen).toBe(true)
    }
  })

  test('getAutoCompactFailureCooldownMs 默认 5 分钟', () => {
    expect(getAutoCompactFailureCooldownMs()).toBe(AUTOCOMPACT_FAILURE_COOLDOWN_MS)
  })

  test('getAutoCompactFailureCooldownMs 接受合法 env override', () => {
    process.env.ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '60000'
    expect(getAutoCompactFailureCooldownMs()).toBe(60_000)
  })

  test('getAutoCompactFailureCooldownMs 拒绝小于 floor 的值', () => {
    process.env.ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '5000'  // < 10000
    expect(getAutoCompactFailureCooldownMs()).toBe(AUTOCOMPACT_FAILURE_COOLDOWN_MS)
  })

  test('getAutoCompactFailureCooldownMs 拒绝非整数', () => {
    process.env.ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS = 'abc'
    expect(getAutoCompactFailureCooldownMs()).toBe(AUTOCOMPACT_FAILURE_COOLDOWN_MS)
  })

  test('getAutoCompactFailureCooldownMs 拒绝前导零', () => {
    process.env.ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '030000'
    expect(getAutoCompactFailureCooldownMs()).toBe(AUTOCOMPACT_FAILURE_COOLDOWN_MS)
  })

  test('MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3(per spec §9.1)', () => {
    expect(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES).toBe(3)
  })

  test('MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS = 10_000(per spec §9.3)', () => {
    expect(MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS).toBe(10_000)
  })
})