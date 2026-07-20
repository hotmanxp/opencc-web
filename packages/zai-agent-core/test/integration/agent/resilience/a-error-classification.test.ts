/**
 * 集成测试 — A.1 错误分类 (classifyApiError).
 *
 * 覆盖 spec §3 行为 1-5 + spec §4 的 8 个 case。
 * TDD:先写失败测试,再实现 classification.ts 让它转绿。
 */
import { describe, test, expect } from 'vitest'
import { classifyApiError } from '../../../../src/runtime/errors/classification.js'

describe('integration: classifyApiError (错误分类)', () => {
  // ---- 1. Anthropic.APIError status 413 → prompt_too_long ----

  test('classifies Anthropic.APIError status 413 → kind:prompt_too_long, retryable:false', () => {
    const err = Object.assign(new Error('prompt is too long'), {
      status: 413,
      error: { type: 'prompt_too_long' },
    })
    const r = classifyApiError(err)
    expect(r.kind).toBe('prompt_too_long')
    expect(r.retryable).toBe(false)
    expect(r.providerErrorCode).toBe('prompt_too_long')
  })

  // ---- 2. Anthropic.APIError status 429 → rate_limit ----

  test('classifies Anthropic.APIError status 429 → kind:rate_limit, retryable:true', () => {
    const err = Object.assign(new Error('rate limited'), {
      status: 429,
      error: { type: 'rate_limit_error' },
    })
    const r = classifyApiError(err)
    expect(r.kind).toBe('rate_limit')
    expect(r.retryable).toBe(true)
  })

  // ---- 3. Anthropic.APIError status 529 → rate_limit (overloaded 视为 rate_limit) ----

  test('classifies Anthropic.APIError status 529 → kind:rate_limit, retryable:true', () => {
    const err = Object.assign(new Error('overloaded'), {
      status: 529,
      error: { type: 'overloaded_error' },
    })
    const r = classifyApiError(err)
    expect(r.kind).toBe('rate_limit')
    expect(r.retryable).toBe(true)
  })

  // ---- 4. Anthropic.APIError status 401 → auth, NOT retryable ----

  test('classifies Anthropic.APIError status 401 → kind:auth, retryable:false', () => {
    const err = Object.assign(new Error('unauthorized'), {
      status: 401,
      error: { type: 'authentication_error' },
    })
    const r = classifyApiError(err)
    expect(r.kind).toBe('auth')
    expect(r.retryable).toBe(false)
  })

  // ---- 5. network error (ECONNRESET) → unknown, retryable ----

  test('classifies network error (ECONNRESET) → kind:unknown, retryable:true', () => {
    const err = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    })
    const r = classifyApiError(err)
    expect(r.kind).toBe('unknown')
    expect(r.retryable).toBe(true)
  })

  // ---- 6. message containing 'prompt_too_long' literal → prompt_too_long ----

  test('classifies message containing "prompt_too_long" literal → kind:prompt_too_long', () => {
    const err = new Error('upstream rejected request: prompt_too_long detected')
    const r = classifyApiError(err)
    expect(r.kind).toBe('prompt_too_long')
  })

  // ---- 7. preserves provider error code in payload ----

  test('preserves provider error code in payload (proxy code 字段)', () => {
    const err = Object.assign(new Error('boom'), {
      status: 500,
      code: 'proxy_internal_error',
    })
    const r = classifyApiError(err)
    expect(r.providerErrorCode).toBe('proxy_internal_error')
  })

  // ---- 8. unknown error type → kind:unknown, retryable:true, message:'unrecognized error' ----

  test('unknown error type → kind:unknown, retryable:true, message:unrecognized error', () => {
    const r = classifyApiError('a weird string that is not an Error')
    expect(r.kind).toBe('unknown')
    expect(r.retryable).toBe(true)
    expect(r.message).toBe('unrecognized error')
  })

  // ---- 9. classifyApiError never throws, even on weird inputs ----

  test('classifyApiError 永不抛 — 输入 null / undefined / symbol', () => {
    expect(() => classifyApiError(null)).not.toThrow()
    expect(() => classifyApiError(undefined)).not.toThrow()
    expect(() => classifyApiError(Symbol('x'))).not.toThrow()
    expect(() => classifyApiError(42)).not.toThrow()
  })
})