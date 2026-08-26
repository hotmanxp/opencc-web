import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TextDebouncer } from '../../../src/server/services/weixinBot/debounce.js'

describe('TextDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  it('initial enqueue flushes after default delay', async () => {
    const d = new TextDebouncer({ defaultDelaySeconds: 3, splitDelaySeconds: 5 })
    const flushed: string[] = []
    d.enqueue('k1', { text: 'hello', mediaPaths: [], mediaTypes: [] }, (item) => {
      flushed.push(item.text)
    })
    expect(flushed).toEqual([])
    vi.advanceTimersByTime(2999)
    expect(flushed).toEqual([])
    vi.advanceTimersByTime(2)
    expect(flushed).toEqual(['hello'])
  })

  it('repeated enqueues within window concatenate and reset timer', async () => {
    const d = new TextDebouncer({ defaultDelaySeconds: 3, splitDelaySeconds: 5 })
    const flushed: string[] = []
    const onFlush = (item: { text: string }) => flushed.push(item.text)
    d.enqueue('k1', { text: 'a', mediaPaths: [], mediaTypes: [] }, onFlush)
    await vi.advanceTimersByTimeAsync(1000)
    d.enqueue('k1', { text: 'b', mediaPaths: [], mediaTypes: [] }, onFlush)
    await vi.advanceTimersByTimeAsync(1000)
    d.enqueue('k1', { text: 'c', mediaPaths: [], mediaTypes: [] }, onFlush)
    // 3rd enqueue 触发了 3000ms 的 timer,再 advance 3100ms 触发
    expect(flushed).toEqual([])
    await vi.advanceTimersByTimeAsync(3100)
    expect(flushed).toEqual(['a\nb\nc'])
  })

  it('last fragment >= splitThreshold uses splitDelay', async () => {
    const d = new TextDebouncer({ defaultDelaySeconds: 3, splitDelaySeconds: 5, splitThreshold: 10 })
    const flushed: string[] = []
    d.enqueue('k1', { text: 'x'.repeat(20), mediaPaths: [], mediaTypes: [] }, (item) => {
      flushed.push(item.text)
    })
    vi.advanceTimersByTime(3000)
    expect(flushed).toEqual([]) // still waiting for split delay
    vi.advanceTimersByTime(2000)
    expect(flushed).toEqual(['x'.repeat(20)])
  })

  it('different keys are independent', async () => {
    const d = new TextDebouncer({ defaultDelaySeconds: 1 })
    const flushed: string[] = []
    d.enqueue('a', { text: 'A', mediaPaths: [], mediaTypes: [] }, (i) => { flushed.push(i.text) })
    d.enqueue('b', { text: 'B', mediaPaths: [], mediaTypes: [] }, (i) => { flushed.push(i.text) })
    vi.advanceTimersByTime(1100)
    expect(flushed.sort()).toEqual(['A', 'B'])
  })

  it('media-only path bypasses debounce when text empty', () => {
    // 验证 media-only: enqueue 触发,文本为空但 mediaPaths 1 → onFlush 仍跑
    const d = new TextDebouncer({ defaultDelaySeconds: 1 })
    const flushed: string[][] = []
    d.enqueue('k', { text: '', mediaPaths: ['/a.jpg'], mediaTypes: ['image/jpeg'] }, (i) => {
      flushed.push(i.mediaPaths)
    })
    vi.advanceTimersByTime(1100)
    expect(flushed).toEqual([['/a.jpg']])
  })

  it('flushAll drains everything immediately', () => {
    const d = new TextDebouncer({ defaultDelaySeconds: 10 })
    const flushed: string[] = []
    d.enqueue('a', { text: 'A', mediaPaths: [], mediaTypes: [] }, (i) => { flushed.push(i.text) })
    d.enqueue('b', { text: 'B', mediaPaths: [], mediaTypes: [] }, (i) => { flushed.push(i.text) })
    d.flushAll((_, item) => { flushed.push(item.text) })
    expect(flushed.sort()).toEqual(['A', 'B'])
    vi.useRealTimers()
  })
})
