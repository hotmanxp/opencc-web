import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageDeduplicator } from '../../../src/server/services/weixinBot/stores/MessageDeduplicator.js'

describe('MessageDeduplicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('first time returns false (not duplicate)', () => {
    const d = new MessageDeduplicator({ ttlSeconds: 60 })
    expect(d.isDuplicate('k1')).toBe(false)
  })

  it('second time within TTL returns true', () => {
    const d = new MessageDeduplicator({ ttlSeconds: 60 })
    d.isDuplicate('k1')
    vi.advanceTimersByTime(10_000)
    expect(d.isDuplicate('k1')).toBe(true)
  })

  it('after TTL expiry returns false again', () => {
    const d = new MessageDeduplicator({ ttlSeconds: 60 })
    d.isDuplicate('k1')
    vi.advanceTimersByTime(61_000)
    expect(d.isDuplicate('k1')).toBe(false)
  })

  it('hit refreshes TTL', () => {
    const d = new MessageDeduplicator({ ttlSeconds: 60 })
    d.isDuplicate('k1')
    vi.advanceTimersByTime(50_000)
    expect(d.isDuplicate('k1')).toBe(true) // hits + extends
    vi.advanceTimersByTime(50_000)
    expect(d.isDuplicate('k1')).toBe(true) // still in extended window
  })

  it('different keys are independent', () => {
    const d = new MessageDeduplicator({ ttlSeconds: 60 })
    expect(d.isDuplicate('a')).toBe(false)
    expect(d.isDuplicate('b')).toBe(false)
    expect(d.isDuplicate('a')).toBe(true)
    expect(d.isDuplicate('b')).toBe(true)
  })

  it('clear wipes everything', () => {
    const d = new MessageDeduplicator({ ttlSeconds: 60 })
    d.isDuplicate('a')
    d.clear()
    expect(d.isDuplicate('a')).toBe(false)
  })
})
