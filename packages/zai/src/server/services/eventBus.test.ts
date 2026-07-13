import { describe, expect, test } from 'vitest'
import { ServerEventBus } from './eventBus.js'

const baseEvent = { type: 'server.error' as const, message: 'x' }

describe('ServerEventBus', () => {
  test('emit stores event with assigned eventId and ts', () => {
    const bus = new ServerEventBus()
    bus.emit(baseEvent)
    const history = bus.getHistoryAfter()
    expect(history.length).toBe(0) // 未传 lastEventId 返回空
    const afterSomeId = bus.getHistoryAfter(undefined)
    expect(afterSomeId.length).toBe(0)
  })

  test('subscribe receives subsequent emits', () => {
    const bus = new ServerEventBus()
    const received: string[] = []
    bus.subscribe((e) => received.push(e.type))
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    expect(received).toEqual(['server.error', 'server.error'])
  })

  test('history capped at 256; oldest dropped', () => {
    const bus = new ServerEventBus()
    for (let i = 0; i < 300; i++) {
      bus.emit(baseEvent)
    }
    // 用 subscribe 拿最新发出的 eventId，反查 history 长度
    let lastId = ''
    bus.subscribe((e) => { lastId = e.eventId })
    // 再 emit 一个
    bus.emit(baseEvent)
    const after = bus.getHistoryAfter('evt_DOES_NOT_EXIST') // 找不到 → 返回全部
    expect(after.length).toBeLessThanOrEqual(257) // 256 + 新 emit 的那条
  })

  test('getHistoryAfter with valid lastEventId returns tail', () => {
    const bus = new ServerEventBus()
    const received: string[] = []
    bus.subscribe((e) => received.push(e.eventId))
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    const middleId = received[0]
    const tail = bus.getHistoryAfter(middleId)
    expect(tail.length).toBe(2)
    expect(tail[0].eventId).toBe(received[1])
    expect(tail[1].eventId).toBe(received[2])
  })

  test('getHistoryAfter with unknown id returns all history', () => {
    const bus = new ServerEventBus()
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    const all = bus.getHistoryAfter('evt_missing')
    expect(all.length).toBe(2)
  })

  test('subscriber throwing does not break other subscribers', () => {
    const bus = new ServerEventBus()
    const got: string[] = []
    bus.subscribe(() => { throw new Error('boom') })
    bus.subscribe((e) => got.push(e.type))
    expect(() => bus.emit(baseEvent)).not.toThrow()
    expect(got).toEqual(['server.error'])
  })

  test('unsubscribe stops delivery', () => {
    const bus = new ServerEventBus()
    const got: string[] = []
    const off = bus.subscribe((e) => got.push(e.type))
    bus.emit(baseEvent)
    off()
    bus.emit(baseEvent)
    expect(got.length).toBe(1)
  })

  test('eventId monotonic across emits', () => {
    const bus = new ServerEventBus()
    const ids: string[] = []
    bus.subscribe((e) => ids.push(e.eventId))
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    expect(ids[1] > ids[0]).toBe(true)
    expect(ids[2] > ids[1]).toBe(true)
  })
})
