import { describe, expect, it, beforeEach } from 'bun:test'
import {
  getCurrentUsage,
  getTokenCountFromUsage,
  finalContextTokensFromLastResponse,
  messageTokenCountFromLastAPIResponse,
} from './tokens.js'
import { IncrementalTokenCounter } from './incrementalTokenCounter.js'

interface FakeUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

describe('tokens', () => {
  describe('getTokenCountFromUsage', () => {
    it('sums all token fields on a populated usage', () => {
      expect(
        getTokenCountFromUsage({
          input_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 30,
          output_tokens: 20,
        } as never),
      ).toBe(200)
    })

    it('returns 0 for undefined usage without throwing', () => {
      // Regression: usage?.input_tokens ?? 0 guard added because
      // getTokenCountFromUsage is reachable with undefined on the
      // `Usage` (BetaUsage) parameter at runtime. Pre-fix this
      // would throw `Cannot read properties of undefined (reading
      // 'input_tokens')`.
      expect(getTokenCountFromUsage(undefined as never)).toBe(0)
    })

    it('treats missing fields as zero', () => {
      expect(
        getTokenCountFromUsage({
          input_tokens: 0,
          output_tokens: 0,
        } as never),
      ).toBe(0)
    })
  })
})

// Build a minimal assistant message with a sparse usage object. Models
// other than '<synthetic>' and content other than the synthetic set pass
// getTokenUsage's filter, so the returned usage is exactly the object we
// attach — letting each test pin the runtime shape (missing/undefined
// fields) that the production guard has to survive.
function makeAssistantMsg(usage: Record<string, unknown> | undefined) {
  return {
    type: 'assistant',
    message: {
      usage,
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'real response' }],
    },
  } as never
}

describe('tokens - sparse usage regression', () => {
  it('getCurrentUsage returns 0 (not undefined) for usage with missing input_tokens/output_tokens', () => {
    // Regression: previously getCurrentUsage returned
    // `input_tokens: usage.input_tokens` directly. With a 3P provider's
    // sparse usage object (e.g. `{ output_tokens: 100 }`), `input_tokens`
    // was undefined at runtime despite the type saying `number`. Downstream
    // `apiUsage.input_tokens + cache_creation_input_tokens` produced NaN
    // and `currentUsage.input_tokens` could throw `Cannot read properties
    // of undefined (reading 'input_tokens')` on stricter consumers.
    const result = getCurrentUsage([
      makeAssistantMsg({ output_tokens: 100 }),
    ])
    expect(result).toEqual({
      input_tokens: 0,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
  })

  it('getCurrentUsage returns null for an explicit-undefined usage (not a truthy sparse object)', () => {
    // The `'usage' in msg.message` check in getTokenUsage can leak an
    // explicit-undefined `usage` value as a truthy sparse {} — that
    // path is preserved here to document the boundary.
    const result = getCurrentUsage([makeAssistantMsg(undefined)])
    expect(result).toBeNull()
  })

  it('finalContextTokensFromLastResponse returns 0 (not NaN) when input_tokens and output_tokens are missing', () => {
    // Regression: `usage.input_tokens + usage.output_tokens` was
    // unguarded. With sparse usage this became `undefined + undefined`
    // = NaN, corrupting task_budget.remaining across compactions.
    const result = finalContextTokensFromLastResponse([
      makeAssistantMsg({ output_tokens: 50 }),
    ])
    expect(result).toBe(50)
  })

  it('messageTokenCountFromLastAPIResponse returns 0 (not undefined) when output_tokens is missing', () => {
    // Regression: `return usage.output_tokens` was unguarded. With sparse
    // usage this returned undefined despite the `number` return type.
    const result = messageTokenCountFromLastAPIResponse([
      makeAssistantMsg({ input_tokens: 7 }),
    ])
    expect(result).toBe(0)
  })
})

describe('IncrementalTokenCounter', () => {
  it('uses cached count for same message length', () => {
    const counter = new IncrementalTokenCounter()
    
    counter.getCount([
      { type: 'user', message: { content: 'hello' } } as any,
    ])
    
    expect(counter.cachedCount).toBeGreaterThan(0)
  })

  it('increments for new messages', () => {
    const counter = new IncrementalTokenCounter()
    
    const count1 = counter.getCount([
      { type: 'user', message: { content: 'hello' } } as any,
    ])
    
    const count2 = counter.getCount([
      { type: 'user', message: { content: 'hello' } } as any,
      { type: 'user', message: { content: 'world' } } as any,
    ])
    
    expect(count2).toBeGreaterThan(count1)
  })

  it('resets correctly', () => {
    const counter = new IncrementalTokenCounter()
    
    counter.getCount([{ type: 'user', message: { content: 'hello' } } as any])
    counter.reset()
    
    expect(counter.cachedCount).toBe(0)
    expect(counter.messageCount).toBe(0)
  })
})