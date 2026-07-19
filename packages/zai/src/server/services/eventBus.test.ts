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

  // ========== Per-sid isolation (regression: 两个 tab 互串消息) ==========

  test('subscribeScoped 收 sid 匹配的事件', () => {
    const bus = new ServerEventBus()
    const got: string[] = []
    bus.subscribeScoped('A', (e) => got.push(e.type))
    bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: 'hi' } as any)
    bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: 'world' } as any)
    expect(got.length).toBe(2)
    expect(got).toEqual(['runtime.delta', 'runtime.delta'])
  })

  test('subscribeScoped 不收其它 sid 的事件', () => {
    const bus = new ServerEventBus()
    const got: string[] = []
    bus.subscribeScoped('A', (e) => got.push(e.type))
    bus.emit({ type: 'runtime.delta', sessionId: 'B', turnIndex: 0, delta: 'x' } as any)
    bus.emit({ type: 'runtime.tool_call', sessionId: 'B', turnIndex: 0, toolUseId: 't', toolName: 'n', input: {} } as any)
    bus.emit({ type: 'prompt.ask', sessionId: 'B', toolUseId: 't', questions: [] } as any)
    bus.emit({ type: 'job.started', jobId: 'j', kind: 'agent_task', sessionId: 'B' } as any)
    expect(got).toEqual([])
  })

  test('subscribeScoped 照收全局事件 (session.* / system.*)', () => {
    const bus = new ServerEventBus()
    const got: string[] = []
    bus.subscribeScoped('A', (e) => got.push(e.type))
    bus.emit({ type: 'session.created', sessionId: 'B', title: 'b', cwd: '/x' } as any)
    bus.emit({ type: 'session.deleted', sessionId: 'B' } as any)
    bus.emit({ type: 'session.renamed', sessionId: 'B', title: 't' } as any)
    bus.emit({ type: 'server.error', message: 'oops' } as any)
    bus.emit({ type: 'toast', level: 'info', message: 'hi' } as any)
    bus.emit({ type: 'branch.changed', branch: 'main' } as any)
    bus.emit({ type: 'server.connected', sessionId: null } as any)
    expect(got).toEqual([
      'session.created', 'session.deleted', 'session.renamed',
      'server.error', 'toast', 'branch.changed', 'server.connected',
    ])
  })

  test('subscribeScoped(null) 维持旧行为 (不过滤)', () => {
    const bus = new ServerEventBus()
    const got: string[] = []
    bus.subscribeScoped(null, (e) => got.push(e.type))
    bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: 'x' } as any)
    bus.emit({ type: 'runtime.delta', sessionId: 'B', turnIndex: 0, delta: 'y' } as any)
    expect(got.length).toBe(2)
  })

  test('subscribeScoped unsubscribe 后停止派发', () => {
    const bus = new ServerEventBus()
    const got: string[] = []
    const off = bus.subscribeScoped('A', (e) => got.push(e.type))
    bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: '1' } as any)
    off()
    bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: '2' } as any)
    expect(got.length).toBe(1)
  })

  test('getHistoryAfterForSid 只返回该 sid 的历史, 不含全局事件', () => {
    const bus = new ServerEventBus()
    bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: 'a1' } as any)
    bus.emit({ type: 'runtime.delta', sessionId: 'B', turnIndex: 0, delta: 'b1' } as any)
    bus.emit({ type: 'session.created', sessionId: 'A', title: 't', cwd: '/x' } as any)
    bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: 'a2' } as any)
    const aHistory = bus.getHistoryAfterForSid(undefined, 'A')
    // 不含 lastEventId → 返回空 (要拿到切片首条需要先收一条再重连)
    expect(aHistory.length).toBe(0)
  })

  test('getHistoryAfterForSid 用 lastEventId 续读', () => {
    const bus = new ServerEventBus()
    const got: string[] = []
    bus.subscribeScoped('A', (e) => got.push(e.eventId))
    bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: '1' } as any)
    bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: '2' } as any)
    bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: '3' } as any)
    const mid = got[0]
    const tail = bus.getHistoryAfterForSid(mid, 'A')
    expect(tail.length).toBe(2)
  })

  test('getHistoryAfterForSid 找不到 lastEventId → 返回该 sid 全量', () => {
    const bus = new ServerEventBus()
    bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: '1' } as any)
    bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: '2' } as any)
    bus.emit({ type: 'runtime.delta', sessionId: 'B', turnIndex: 0, delta: 'b' } as any)
    const tail = bus.getHistoryAfterForSid('evt_missing', 'A')
    expect(tail.length).toBe(2)
  })

  test('per-sid history 各自独立裁剪 (CAPACITY=256)', () => {
    const bus = new ServerEventBus()
    // sid A 写 300 条
    for (let i = 0; i < 300; i++) {
      bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: String(i) } as any)
    }
    // sid B 写 1 条
    bus.emit({ type: 'runtime.delta', sessionId: 'B', turnIndex: 0, delta: 'b' } as any)
    // A 切片 ≤ 256, B 切片 = 1
    const aTail = bus.getHistoryAfterForSid('evt_missing', 'A')
    const bTail = bus.getHistoryAfterForSid('evt_missing', 'B')
    expect(aTail.length).toBeLessThanOrEqual(256)
    expect(bTail.length).toBe(1)
  })
})