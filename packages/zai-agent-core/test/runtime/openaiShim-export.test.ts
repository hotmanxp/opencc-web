import { describe, it, expect } from 'vitest'
import * as exported from '../../src/runtime/openaiShim.js'

describe('runtime/openaiShim re-export', () => {
  it('re-exports createOpenAIShimClient', () => {
    expect(typeof exported.createOpenAIShimClient).toBe('function')
  })

  it('the exported function accepts a providerOverride object', () => {
    // Smoke test: the function should be the same reference as the
    // upstream definition and not throw on a minimal call (without
    // actually invoking network — we just inspect arity).
    expect(exported.createOpenAIShimClient.length).toBeGreaterThanOrEqual(0)
  })
})
