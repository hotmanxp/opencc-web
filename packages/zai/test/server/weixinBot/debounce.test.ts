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

  it('flushAll drains everything immediately', async () => {
    const d = new TextDebouncer({ defaultDelaySeconds: 10 })
    const flushed: string[] = []
    d.enqueue('a', { text: 'A', mediaPaths: [], mediaTypes: [] }, (i) => { flushed.push(i.text) })
    d.enqueue('b', { text: 'B', mediaPaths: [], mediaTypes: [] }, (i) => { flushed.push(i.text) })
    await d.flushAll()
    expect(flushed.sort()).toEqual(['A', 'B'])
    vi.useRealTimers()
  })

  it('flushAll uses the per-key handler registered at enqueue time', async () => {
    // Regression: flushAll 早先接收调用方临时传入的回调,而真正的派发闭包
    // 只存在于 enqueue 的参数里 → adapter 断连时缓冲区被静默丢弃,而游标
    // 已经推进,服务端不重投,消息永久丢失。
    const d = new TextDebouncer({ defaultDelaySeconds: 10 })
    const dispatched: string[] = []
    d.enqueue('a', { text: 'buffered', mediaPaths: [], mediaTypes: [] }, (i) => {
      dispatched.push(i.text)
    })
    expect(dispatched).toEqual([])
    await d.flushAll()
    expect(dispatched).toEqual(['buffered'])
    vi.useRealTimers()
  })

  it('flushAll awaits async handlers before resolving', async () => {
    // adapter 靠 flushAll 的 promise 确认「disconnect 返回时消息已落 pending」。
    // 用微任务链而非 setTimeout —— 本文件开了 fake timers,真 setTimeout 不会触发。
    const d = new TextDebouncer({ defaultDelaySeconds: 10 })
    let persisted = false
    d.enqueue('a', { text: 'A', mediaPaths: [], mediaTypes: [] }, async () => {
      await Promise.resolve()
      persisted = true
    })
    await d.flushAll()
    expect(persisted).toBe(true)
    vi.useRealTimers()
  })
})
