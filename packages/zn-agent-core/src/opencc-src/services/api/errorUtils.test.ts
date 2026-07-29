import { describe, expect, test } from 'bun:test'
import type { APIError } from '@anthropic-ai/sdk'
import { briefAPIErrorReason } from './errorUtils.ts'

// Regression coverage for upstream PR #1862 ("honest feedback pass"): the
// compact retry line in SystemAPIErrorMessage shows whatever phrase this
// helper returns. The OpenCC port adds this classifier so transient rate
// limits / transport errors get an actionable phrase instead of "API error".
describe('briefAPIErrorReason', () => {
  test('classifies 429 as Rate limited', () => {
    expect(briefAPIErrorReason({ message: 'x', status: 429 } as APIError)).toBe(
      'Rate limited',
    )
  })

  test('classifies 529 as API overloaded', () => {
    expect(briefAPIErrorReason({ message: 'x', status: 529 } as APIError)).toBe(
      'API overloaded',
    )
  })

  test('classifies 5xx (non-529) as API server error', () => {
    expect(briefAPIErrorReason({ message: 'x', status: 503 } as APIError)).toBe(
      'API server error',
    )
    expect(briefAPIErrorReason({ message: 'x', status: 500 } as APIError)).toBe(
      'API server error',
    )
  })

  test('falls back to "API error" for non-retryable 4xx', () => {
    expect(briefAPIErrorReason({ message: 'x', status: 400 } as APIError)).toBe(
      'API error',
    )
    expect(briefAPIErrorReason({ message: 'x', status: 401 } as APIError)).toBe(
      'API error',
    )
  })

  test('classifies a generic OpenAI-compat transport error', () => {
    expect(
      briefAPIErrorReason({
        message:
          'OpenAI API transport error: fetch failed [openai_category=localhost_resolution_failed]',
      } as APIError),
    ).toBe('Connection issue')
  })

  test('classifies ECONNREFUSED / ENOTFOUND / EAI_AGAIN in message text', () => {
    expect(
      briefAPIErrorReason({ message: 'fetch failed: ECONNREFUSED' } as APIError),
    ).toBe('Connection issue')
    expect(
      briefAPIErrorReason({ message: 'getaddrinfo ENOTFOUND api.openai.com' } as APIError),
    ).toBe('Connection issue')
    expect(
      briefAPIErrorReason({ message: 'lookup EAI_AGAIN example.com' } as APIError),
    ).toBe('Connection issue')
  })

  test('classifies the legacy "Connection error." literal', () => {
    expect(
      briefAPIErrorReason({ message: 'Connection error.' } as APIError),
    ).toBe('Connection issue')
  })

  test('classifies an Error instance with ETIMEDOUT cause', () => {
    // extractConnectionErrorDetails only walks Error instances (not plain
    // objects), so the cause chain must be Error-shaped for the timeout to
    // surface here.
    const inner = new Error('Connect timeout') as Error & { code?: string }
    inner.code = 'ETIMEDOUT'
    const outer = new Error('socket hang up') as Error & { cause?: unknown }
    outer.cause = inner
    expect(briefAPIErrorReason(outer as unknown as APIError)).toBe(
      'Request timed out',
    )
  })

  test('falls back to "API error" for an unrecognised shape', () => {
    expect(
      briefAPIErrorReason({ message: 'weird and unrelated' } as APIError),
    ).toBe('API error')
  })
})
