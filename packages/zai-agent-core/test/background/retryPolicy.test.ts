import { describe, expect, test } from 'vitest'
import {
  RETRY_POLICY,
  classifyRetryableError,
  getRetryDelay,
  isQuotaExhausted,
} from '../../src/runtime/background/retryPolicy.js'

describe('RETRY_POLICY constants', () => {
  test('aligns with OpenCC defaults', () => {
    expect(RETRY_POLICY.maxRetries).toBe(10)
    expect(RETRY_POLICY.max529Retries).toBe(3)
    expect(RETRY_POLICY.baseDelayMs).toBe(500)
    expect(RETRY_POLICY.maxDelayMs).toBe(32_000)
  })
})

describe('getRetryDelay', () => {
  test('grows exponentially up to cap', () => {
    // jitterRatio=0 关闭抖动,验证纯指数公式.
    const samples = Array.from({ length: 11 }, (_, i) =>
      getRetryDelay(i + 1, 500, 32_000, 0),
    )
    // 500, 1000, 2000, 4000, 8000, 16000, 32000, 32000, ...
    expect(samples[0]).toBe(500)
    expect(samples[1]).toBe(1000)
    expect(samples[2]).toBe(2000)
    expect(samples[3]).toBe(4000)
    expect(samples[4]).toBe(8000)
    expect(samples[5]).toBe(16_000)
    expect(samples[6]).toBe(32_000)
    expect(samples[7]).toBe(32_000)
    expect(samples[8]).toBe(32_000)
    expect(samples[10]).toBe(32_000)
  })

  test('jitter stays within ±25% of base', () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const base = Math.min(500 * 2 ** (attempt - 1), 32_000)
      const min = base
      const max = base * 1.25
      for (let i = 0; i < 100; i++) {
        const d = getRetryDelay(attempt, 500, 32_000, 0.25)
        expect(d).toBeGreaterThanOrEqual(min - 0.01)
        expect(d).toBeLessThanOrEqual(max + 0.01)
      }
    }
  })
})

describe('isQuotaExhausted', () => {
  test('429 + "limit: 0" → quota exhausted', () => {
    expect(
      isQuotaExhausted({
        status: 429,
        message: 'limit: 0 for current plan',
      }),
    ).toBe(true)
  })

  test('429 + "exceeded your current quota" → quota exhausted', () => {
    expect(
      isQuotaExhausted({
        status: 429,
        message: 'You have exceeded your current quota',
      }),
    ).toBe(true)
  })

  test('429 普通 rate limit → not quota exhausted', () => {
    expect(
      isQuotaExhausted({
        status: 429,
        message: 'Too many requests, slow down',
      }),
    ).toBe(false)
  })

  test('非 429 → not quota exhausted', () => {
    expect(
      isQuotaExhausted({ status: 503, message: 'limit: 0' }),
    ).toBe(false)
  })

  test('undefined → not quota exhausted', () => {
    expect(isQuotaExhausted(undefined)).toBe(false)
  })
})

describe('classifyRetryableError', () => {
  test('529 → overloaded, retryable', () => {
    const d = classifyRetryableError({ status: 529, message: 'overloaded' })
    expect(d.category).toBe('llm_provider_overloaded')
    expect(d.retryable).toBe(true)
    expect(d.isTransientCapacity).toBe(true)
  })

  test('"overloaded_error" in message → overloaded, retryable', () => {
    const d = classifyRetryableError({
      status: undefined,
      message: JSON.stringify({
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: '当前服务集群负载较高',
        },
      }),
    })
    expect(d.category).toBe('llm_provider_overloaded')
    expect(d.retryable).toBe(true)
  })

  test('429 普通 → rate_limit, retryable', () => {
    const d = classifyRetryableError({
      status: 429,
      message: 'Too many requests',
    })
    expect(d.category).toBe('llm_provider_rate_limit')
    expect(d.retryable).toBe(true)
    expect(d.isTransientCapacity).toBe(true)
  })

  test('429 quota-exhausted → internal, NOT retryable', () => {
    const d = classifyRetryableError({
      status: 429,
      message: 'limit: 0',
    })
    expect(d.category).toBe('internal')
    expect(d.retryable).toBe(false)
  })

  test('500 → server, retryable', () => {
    const d = classifyRetryableError({ status: 500, message: 'oops' })
    expect(d.category).toBe('llm_provider_server')
    expect(d.retryable).toBe(true)
  })

  test('503 → server, retryable', () => {
    const d = classifyRetryableError({ status: 503, message: 'unavailable' })
    expect(d.category).toBe('llm_provider_server')
    expect(d.retryable).toBe(true)
  })

  test('"fetch failed" → server, retryable', () => {
    const d = classifyRetryableError(new Error('fetch failed'))
    expect(d.category).toBe('llm_provider_server')
    expect(d.retryable).toBe(true)
  })

  test('"ECONNRESET" → server, retryable', () => {
    const d = classifyRetryableError(new Error('read ECONNRESET'))
    expect(d.category).toBe('llm_provider_server')
    expect(d.retryable).toBe(true)
  })

  test('"timeout" → server, retryable', () => {
    const d = classifyRetryableError(new Error('Request timeout'))
    expect(d.category).toBe('llm_provider_server')
    expect(d.retryable).toBe(true)
  })

  test('401 → auth, NOT retryable', () => {
    const d = classifyRetryableError({ status: 401, message: 'unauthorized' })
    expect(d.category).toBe('llm_provider_auth')
    expect(d.retryable).toBe(false)
  })

  test('403 → auth, NOT retryable', () => {
    const d = classifyRetryableError({ status: 403, message: 'forbidden' })
    expect(d.category).toBe('llm_provider_auth')
    expect(d.retryable).toBe(false)
  })

  test('400 → internal, NOT retryable', () => {
    const d = classifyRetryableError({ status: 400, message: 'bad request' })
    expect(d.category).toBe('internal')
    expect(d.retryable).toBe(false)
  })

  test('unknown Error → internal, NOT retryable', () => {
    const d = classifyRetryableError(new Error('something weird'))
    expect(d.category).toBe('internal')
    expect(d.retryable).toBe(false)
  })

  test('string → internal, NOT retryable', () => {
    const d = classifyRetryableError('plain string error')
    expect(d.category).toBe('internal')
    expect(d.retryable).toBe(false)
  })

  test('null → internal, NOT retryable', () => {
    const d = classifyRetryableError(null)
    expect(d.category).toBe('internal')
    expect(d.retryable).toBe(false)
  })

  test('delayMs is positive when retryable', () => {
    const d = classifyRetryableError({ status: 529, message: 'overloaded' })
    expect(d.delayMs).toBeGreaterThan(0)
    const d2 = classifyRetryableError({ status: 503, message: 'no' })
    expect(d2.delayMs).toBeGreaterThan(0)
  })
})