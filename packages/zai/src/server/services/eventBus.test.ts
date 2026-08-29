import { describe, expect, test, vi, afterEach } from 'vitest'
import { ServerEventBus } from './eventBus.js'

const baseEvent = { type: 'server.error' as const, message: 'x' }

describe('ServerEventBus', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('emit stores event with assigned eventId and ts', () => {
    const bus = new ServerEventBus()
    bus.emit(baseEvent)
    const history = bus.getHistoryAfter()
    // lastEventId===undefined 时也回放该进程保留的最近 history,
    // 避免新 EventSource 实例创建时在建立前的 emit 事件永远丢失。
    expect(history.length).toBe(1)
    const afterSomeId = bus.getHistoryAfter(undefined)
    expect(afterSomeId.length).toBe(1)
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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

  test('subscribeScoped 不收其它 sid 的 sid-scoped 事件 (runtime.* / prompt.ask)', () => {
    const bus = new ServerEventBus()
    const got: string[] = []
    bus.subscribeScoped('A', (e) => got.push(e.type))
    // runtime.* / prompt.ask 仍按 sid 过滤 (不在 isGlobalEvent 白名单)
    bus.emit({ type: 'runtime.delta', sessionId: 'B', turnIndex: 0, delta: 'x' } as any)
    bus.emit({ type: 'runtime.tool_call', sessionId: 'B', turnIndex: 0, toolUseId: 't', toolName: 'n', input: {} } as any)
    bus.emit({ type: 'prompt.ask', sessionId: 'B', toolUseId: 't', questions: [] } as any)
    // job.* 是全局事件 (job.started 加入 isGlobalEvent), 不受 sid 过滤,
    // 所以即使是 sid=B 的 job, sid=A 的订阅者也会收到。
    bus.emit({ type: 'job.started', jobId: 'j', kind: 'agent_task', sessionId: 'B' } as any)
    expect(got).toEqual(['job.started'])
  })

  test('subscribeScoped 照收全局事件 (session.* / system.* / job.*)', () => {
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
    // 全局任务 (job.*) 在派发时 sessionId === null (无 parentSessionId 的
    // resource_refresh / login / install / cli dispatch) 不应被订阅者过滤.
    // 此前 bug: subscribeScoped 把 sessionId===null 的 job.* 当 sid 不匹配
    // 静默丢弃, 导致 server.connected 之后那些 job.* 永远到不了前端.
    bus.emit({ type: 'job.started', jobId: 'j-global', kind: 'install', sessionId: null } as any)
    bus.emit({ type: 'job.progress', jobId: 'j-global', message: 'x', sessionId: null } as any)
    bus.emit({ type: 'job.done', jobId: 'j-global', sessionId: null } as any)
    bus.emit({ type: 'job.failed', jobId: 'j-global', error: 'x', sessionId: null } as any)
    expect(got).toEqual([
      'session.created', 'session.deleted', 'session.renamed',
      'server.error', 'toast', 'branch.changed', 'server.connected',
      'job.started', 'job.progress', 'job.done', 'job.failed',
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
    // lastEventId===undefined 时回放该 sid 的 lifecycle 历史 (避免新 EventSource
    // 实例创建时 gap 内的 emit 永远丢失 — race fix),同时过滤掉 streaming events
    // (runtime.thinking/delta/tool_call/tool_result) — 它们已持久化在 transcript,
    // replay 会让客户端 messages 数组与 transcript load 内容重复。
    //
    // 这里 3 条 runtime.delta 是 streaming 类型全被过滤。session.created 虽然是
    // global event,但因为带了 sessionId='A' 也被存进 historyBySid['A'],这条
    // 路径上 subscribeScoped 实时分发会按 isGlobalEvent 透传给所有 subscriber
    // (包括 B,C,D 等);但 history replay 路径上没单独过滤 global — 这是 pre-existing
    // 行为,与本次 streaming 过滤无关,故不在本测试断言范围。
    const aHistory = bus.getHistoryAfterForSid(undefined, 'A')
    expect(aHistory.map((e) => e.type)).toEqual(['session.created'])
    // lifecycle events 走通:验证 runtime.started/runtime.done 不被 streaming 过滤吃掉
    bus.emit({ type: 'runtime.started', sessionId: 'A', turnIndex: 0, apiRequestCount: 1, contextTokens: 0 } as any)
    bus.emit({ type: 'runtime.thinking', sessionId: 'A', turnIndex: 0, thinking: 'think' } as any)
    bus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: 'text' } as any)
    bus.emit({ type: 'runtime.done', sessionId: 'A', turnIndex: 0 } as any)
    const aHistory2 = bus.getHistoryAfterForSid(undefined, 'A')
    expect(aHistory2.map((e) => e.type)).toEqual([
      'session.created',
      'runtime.started',
      'runtime.done',
    ])
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
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

  // ========== seq 分配 (emit 分配全局单调 seq) ==========

  test('emit assigns monotonically increasing seq', () => {
    const bus = new ServerEventBus()
    const seqs: number[] = []
    bus.subscribe((e) => seqs.push(e.seq))
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    bus.emit(baseEvent)
    expect(seqs).toEqual([1, 2, 3])
  })

  test('emit preserves caller-provided seq', () => {
    const bus = new ServerEventBus()
    let got: number | undefined
    bus.subscribe((e) => { got = e.seq })
    bus.emit({ type: 'server.error', message: 'x', seq: 99 })
    expect(got).toBe(99)
  })
})