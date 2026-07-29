import { describe, expect, it } from 'bun:test'
import { sealForVmBoundary, MAX_ARRAY_LEN } from './vmSealer.ts'

describe('sealForVmBoundary', () => {
  it('passes through plain objects', () => {
    const input = { a: 1, b: 'x' }
    expect(sealForVmBoundary(input)).toEqual({ a: 1, b: 'x' })
  })

  it('drops functions silently', () => {
    const input = { fn: () => 42, value: 7 }
    expect(sealForVmBoundary(input)).toEqual({ value: 7 })
  })

  it('strips __proto__ keys', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"safe":1}')
    const out = sealForVmBoundary(input) as Record<string, unknown>
    expect('__proto__' in out).toBe(false)
    expect(out.safe).toBe(1)
  })

  it('caps arrays at MAX_ARRAY_LEN', () => {
    const input = new Array(MAX_ARRAY_LEN + 10).fill('x')
    expect(() => sealForVmBoundary(input)).toThrow(/exceeds the maximum of \d+/)
  })

  it('rejects non-safe-integer length', () => {
    class FakeArray { get length() { return Number.MAX_SAFE_INTEGER + 10 } }
    expect(() => sealForVmBoundary(new FakeArray() as never)).toThrow(/not a safe integer/)
  })

  it('recursively seals nested objects', () => {
    const input = { nested: { fn: () => 1, value: 'ok' }, arr: [1, { fn: () => 2, value: 2 }] }
    const out = sealForVmBoundary(input) as { nested: { fn?: unknown; value: string }; arr: unknown[] }
    expect(out.nested.value).toBe('ok')
    expect(out.nested.fn).toBeUndefined()
    expect(out.arr[0]).toBe(1)
    const arrItem1 = out.arr[1] as { fn?: unknown; value: number }
    expect(arrItem1.value).toBe(2)
    expect(arrItem1.fn).toBeUndefined()
  })
})