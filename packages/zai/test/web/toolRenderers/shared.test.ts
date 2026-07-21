// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { pick, stringFromOutput, truncate } from '../../../src/web/src/components/toolRenderers/shared.js'

describe('pick', () => {
  it('keeps only listed keys, leaves input untouched', () => {
    const input = { a: 1, b: 2, c: 3 }
    const out = pick(input, ['a', 'c'])
    expect(out).toEqual({ a: 1, c: 3 })
    expect(input).toEqual({ a: 1, b: 2, c: 3 }) // not mutated
  })
  it('skips absent keys', () => {
    expect(pick({ a: 1 }, ['a', 'missing'])).toEqual({ a: 1 })
  })
})

describe('stringFromOutput', () => {
  it('stringifies string as-is', () => {
    expect(stringFromOutput('plain')).toBe('plain')
  })
  it('JSON-stringifies non-string', () => {
    expect(stringFromOutput({ ok: true })).toBe('{\n  "ok": true\n}')
  })
  it('handles null/undefined safely', () => {
    expect(stringFromOutput(null)).toBe('null')
    expect(stringFromOutput(undefined)).toBe('')
  })
})

describe('truncate', () => {
  it('passes through short strings', () => {
    expect(truncate('hi', 80)).toBe('hi')
  })
  it('truncates with ellipsis when over length', () => {
    expect(truncate('a'.repeat(120), 80)).toBe('a'.repeat(80) + '…')
  })
  it('respects exact-length boundary', () => {
    expect(truncate('a'.repeat(80), 80)).toBe('a'.repeat(80))
  })
})
