// Verifies that vitest's setupFiles mechanism actually loads bun-protocol.mjs
// as a Node loader hook AND that the registered resolve hook intercepts
// `bun:bundle` in the same vitest process. This is a stronger test than the
// subprocess test (bunProtocol.test.mjs) which only verifies `tsx --loader`
// works outside vitest.
//
// If this test passes, setupFiles is verified as the correct vitest mechanism.
// If it fails with ERR_UNSUPPORTED_ESM_URL_SCHEME on the `bun:` protocol,
// setupFiles does NOT install loader hooks and Task 14 needs a different
// approach (e.g. globalSetup, or running tests under tsx --loader).

import { describe, expect, it } from 'vitest'

describe('setupFiles loader hook (vitest in-process)', () => {
  it('resolves bun:bundle in the vitest process via setupFiles loader', async () => {
    const mod = await import('bun:bundle')

    expect(typeof mod.feature).toBe('function')
    expect(typeof mod.require).toBe('function')
    // Sanity: feature() returns true for a static flag in the shim.
    expect(mod.feature('REACTIVE_COMPACT')).toBe(true)
  })
})
