import { describe, expect, it } from 'vitest'
import { executePreCompactHooks, executePostCompactHooks } from '../../../src/runtime/compact/hooks.js'

describe('executePreCompactHooks (no-op)', () => {
  it('manual → {}', async () => {
    expect(await executePreCompactHooks({ trigger: 'manual', customInstructions: null }, new AbortController().signal)).toEqual({})
  })
  it('auto → {}', async () => {
    expect(await executePreCompactHooks({ trigger: 'auto', customInstructions: 'foo' }, new AbortController().signal)).toEqual({})
  })
})

describe('executePostCompactHooks (no-op)', () => {
  it('returns []', async () => {
    expect(await executePostCompactHooks({ trigger: 'manual', summary: 's', messagesToKeep: [] }, new AbortController().signal)).toEqual([])
  })
})
