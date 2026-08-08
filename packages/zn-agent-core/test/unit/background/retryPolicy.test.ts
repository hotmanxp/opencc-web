import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  classifyRetryableError,
  retrySleep,
  isQuotaExhausted,
  getRetryDelay,
  enterRateLimitCooldown,
  getRateLimitCooldownRemainingMs,
  __resetRateLimitCooldownForTests,
  RETRY_POLICY,
} from '../../../src/compat/background/retryPolicy.js'

beforeEach(() => {
  __resetRateLimitCooldownForTests()
})

describe('classifyRetryableError', () => {
  it('429 rate limit 判为可重试 transient capacity', () => {
    const d = classifyRetryableError({ status: 429, message: 'rate limit exceeded' })
    expect(d.retryable).toBe(true)
    expect(d.category).toBe('llm_provider_rate_limit')
    expect(d.isTransientCapacity).toBe(true)
  })

  it('429 quota exhausted 判为不可重试', () => {
    const d = classifyRetryableError({ status: 429, message: 'limit: 0' })
    expect(d.retryable).toBe(false)
    expect(d.category).toBe('internal')
  })

  it('529 overloaded 判为可重试', () => {
    const d = classifyRetryableError({ status: 529, message: 'overloaded_error' })
    expect(d.retryable).toBe(true)
    expect(d.category).toBe('llm_provider_overloaded')
    expect(d.isTransientCapacity).toBe(true)
  })

  it('5xx 判为可重试 server 错误', () => {
    const d = classifyRetryableError({ status: 500, message: 'server error' })
    expect(d.retryable).toBe(true)
    expect(d.category).toBe('llm_provider_server')
    expect(d.isTransientCapacity).toBe(false)
  })

  it('401 auth 判为不可重试', () => {
    const d = classifyRetryableError({ status: 401, message: 'unauthorized' })
    expect(d.retryable).toBe(false)
  })

  it('isQuotaExhausted 识别 429 quota 消息', () => {
    expect(isQuotaExhausted({ status: 429, message: 'limit: 0' })).toBe(true)
    expect(isQuotaExhausted({ status: 429, message: 'exceeded your current quota' })).toBe(true)
    expect(isQuotaExhausted({ status: 429, message: 'rate limit exceeded' })).toBe(false)
    expect(isQuotaExhausted({ status: 500, message: 'server' })).toBe(false)
  })
})

describe('getRetryDelay', () => {
  it('指数退避 500→1000→2000 cap 32s', () => {
    expect(getRetryDelay(1, 500, 32000, 0)).toBe(500)
    expect(getRetryDelay(2, 500, 32000, 0)).toBe(1000)
    expect(getRetryDelay(3, 500, 32000, 0)).toBe(2000)
    // cap: 2^7 = 64000 > 32000
    expect(getRetryDelay(8, 500, 32000, 0)).toBe(32000)
  })

  it('抖动在 0..0.25×backoff 范围内', () => {
    // attempt=2, base=1000 → backoff = 1000×2^1 = 2000, jitter = 0.25×2000 = 500
    for (let i = 0; i < 50; i++) {
      const d = getRetryDelay(2, 1000, 32000, 0.25)
      expect(d).toBeGreaterThanOrEqual(2000)
      expect(d).toBeLessThan(2500)
    }
  })
})

describe('retrySleep abort listener 清理', () => {
  it('timer 正常到期后移除 abort listener(不泄漏)', async () => {
    const ac = new AbortController()
    const addSpy = vi.spyOn(ac.signal, 'addEventListener')
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener')

    await retrySleep(5, ac.signal)

    // addEventListener 应被调用一次(注册 onAbort),removeEventListener 也一次(到期清理)
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(removeSpy).toHaveBeenCalledTimes(1)
  })

  it('abort 时立即 resolve', async () => {
    const ac = new AbortController()
    const start = Date.now()
    const p = retrySleep(10_000, ac.signal)
    ac.abort()
    await p
    expect(Date.now() - start).toBeLessThan(100)
  })

  it('signal 已 aborted 时立即 resolve 不注册 listener', async () => {
    const ac = new AbortController()
    ac.abort()
    const addSpy = vi.spyOn(ac.signal, 'addEventListener')
    await retrySleep(5, ac.signal)
    expect(addSpy).not.toHaveBeenCalled()
  })

  it('无 signal 时纯 timer', async () => {
    const start = Date.now()
    await retrySleep(5)
    expect(Date.now() - start).toBeLessThan(100)
  })
})

describe('429 冷却门', () => {
  it('未冷却时剩余为 0', () => {
    expect(getRateLimitCooldownRemainingMs()).toBe(0)
  })

  it('enterRateLimitCooldown 后剩余时间 > 0 且 <= 窗口', () => {
    enterRateLimitCooldown(30_000)
    const remaining = getRateLimitCooldownRemainingMs()
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(30_000)
  })

  it('默认窗口为 30s', () => {
    enterRateLimitCooldown()
    expect(getRateLimitCooldownRemainingMs()).toBeGreaterThan(29_000)
  })

  it('短窗口到期后剩余归 0', async () => {
    enterRateLimitCooldown(10)
    await new Promise((r) => setTimeout(r, 30))
    expect(getRateLimitCooldownRemainingMs()).toBe(0)
  })
})

describe('RETRY_POLICY', () => {
  it('429/529 共享 3 次上限, 总次数上限 10', () => {
    // 后台任务路径: 429/529 走 consecutive529 计数 (max529Retries=3),
    // 其他可重试错误走 maxRetries=10
    expect(RETRY_POLICY.max529Retries).toBe(3)
    expect(RETRY_POLICY.maxRetries).toBe(10)
  })
})
