import { describe, expect, it } from 'vitest'
import { nextBackoffMs, MAX_RESTART_ATTEMPTS, READY_TIMEOUT_MS } from '../../src/cli/backoff.js'

describe('backoff', () => {
  it('attempts 1-3 yield 1s, 2s, 4s', () => {
    expect(nextBackoffMs(1)).toBe(1000)
    expect(nextBackoffMs(2)).toBe(2000)
    expect(nextBackoffMs(3)).toBe(4000)
  })

  it('caps at attempt 3 and is monotonic', () => {
    expect(nextBackoffMs(4)).toBe(4000)
    expect(nextBackoffMs(8)).toBe(4000)
  })

  it('exposes constants', () => {
    expect(MAX_RESTART_ATTEMPTS).toBe(3)
    expect(READY_TIMEOUT_MS).toBe(30000)
  })
})
