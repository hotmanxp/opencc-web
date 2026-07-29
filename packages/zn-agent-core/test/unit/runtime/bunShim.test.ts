import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { feature, require as bunRequire } from '../../../src/compat/runtime/bun-shim.js'

describe('bun:bundle shim', () => {
  let savedEnv: Record<string, string | undefined> = {}
  beforeEach(() => {
    savedEnv = {}
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('ZAI_OPENCC_FEATURE_')) {
        savedEnv[k] = process.env[k]
        delete process.env[k]
      }
    }
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('feature returns true for STATIC_FEATURES defaults (REACTIVE_COMPACT)', () => {
    expect(feature('REACTIVE_COMPACT')).toBe(true)
  })

  it('feature returns false for unknown flags without defaultValue', () => {
    expect(feature('UNKNOWN_FLAG_xyz123')).toBe(false)
  })

  it('feature returns defaultValue for unknown flags', () => {
    expect(feature('UNKNOWN_FLAG_xyz123', true)).toBe(true)
    expect(feature('UNKNOWN_FLAG_xyz123', 'hello')).toBe('hello')
  })

  it('feature respects ZAI_OPENCC_FEATURE_<FLAG>=1 env override (true)', () => {
    process.env.ZAI_OPENCC_FEATURE_REACTIVE_COMPACT = '1'
    expect(feature('REACTIVE_COMPACT')).toBe(true)
  })

  it('feature respects ZAI_OPENCC_FEATURE_<FLAG>=0 env override (false)', () => {
    process.env.ZAI_OPENCC_FEATURE_REACTIVE_COMPACT = '0'
    expect(feature('REACTIVE_COMPACT')).toBe(false)
  })

  it('feature env override wins over static table (REACTIVE_COMPACT=0)', () => {
    process.env.ZAI_OPENCC_FEATURE_REACTIVE_COMPACT = '0'
    expect(feature('REACTIVE_COMPACT')).toBe(false)
  })

  it('feature env override works for non-static flag', () => {
    process.env.ZAI_OPENCC_FEATURE_NEW_FLAG = 'true'
    expect(feature('NEW_FLAG')).toBe(true)
  })

  it('feature sanitizes non-alnum flag names in env key (hyphen → underscore)', () => {
    process.env.ZAI_OPENCC_FEATURE_FOO_BAR = '1'
    expect(feature('FOO-BAR')).toBe(true)
  })

  it('require() throws with descriptive error', () => {
    expect(() => bunRequire('anything')).toThrow(/bun:bundle stub: require/)
  })
})
