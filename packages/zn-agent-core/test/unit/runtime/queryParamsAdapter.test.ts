import { describe, expect, it } from 'vitest'
import { toQueryParams } from '../../../src/compat/runtime/queryParamsAdapter.js'
import type { QueryOptions } from '../../../src/compat/runtime/types.js'

function makeOpts(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return {
    prompt: { role: 'user', content: 'hello' },
    cwd: '/tmp/test',
    model: 'claude-test',
    tools: [],
    sessionId: 'sess-123',
    abortSignal: new AbortController().signal,
    ...overrides,
  } as QueryOptions
}

describe('toQueryParams', () => {
  it('translates prompt to messages', () => {
    const params = toQueryParams(makeOpts(), {})
    expect(params.messages).toBeDefined()
  })

  it('passes through cwd', () => {
    const params = toQueryParams(makeOpts({ cwd: '/foo' }), {})
    expect(params.cwd).toBe('/foo')
  })

  it('passes through model', () => {
    const params = toQueryParams(makeOpts({ model: 'gpt-x' }), {})
    expect(params.model).toBe('gpt-x')
  })

  it('passes through sessionId', () => {
    const params = toQueryParams(makeOpts({ sessionId: 's1' }), {})
    expect(params.sessionId).toBe('s1')
  })

  it('returns empty tools array when none provided', () => {
    const params = toQueryParams(makeOpts(), {})
    expect(params.tools).toEqual([])
  })
})
