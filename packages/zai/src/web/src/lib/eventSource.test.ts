import { describe, expect, test, vi } from 'vitest'
import type { ServerEvent } from '../../../shared/events.js'
import type { StreamState } from './eventSource.js'

const notifMock = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('antd', () => ({ notification: notifMock }))

// Mirror the real EventSource semantics: the server writes each SSE frame with
// a named `event:` field (e.g. `event: runtime.delta`), and only `addEventListener`
// for that exact name fires — `onmessage` is reserved for the unnamed default.
// The previous mock only exposed `onmessage`, which is why production bugged:
// server-side named events slipped past the front end entirely.
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  onmessage: ((e: { data: string }) => void) | null = null
  onopen: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  close = vi.fn()
  private listeners: Record<string, Array<(e: { data: string }) => void>> = {}
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  addEventListener(name: string, handler: (e: { data: string }) => void) {
    ;(this.listeners[name] ??= []).push(handler)
  }
  emitOpen() {
    this.onopen?.(new Event('open'))
  }
  // Simulate the server-side writeSse producing `event: <name>\ndata: <json>`.
  dispatchNamed(name: string, payload: ServerEvent) {
    const data = JSON.stringify(payload)
    for (const handler of this.listeners[name] ?? []) handler({ data })
  }
}

vi.stubGlobal('EventSource', MockEventSource)

// Dynamic import to ensure mock is applied
const { subscribeServerEvents } = await import('./eventSource.js')

describe('subscribeServerEvents', () => {
  test('connects to /api/event (无 sid)', () => {
    MockEventSource.instances = []
    subscribeServerEvents(null, () => {})
    expect(MockEventSource.instances[0].url).toBe('/api/event')
  })

  test('带 sid 时 URL 含 ?sid=xxx (encodeURIComponent)', () => {
    MockEventSource.instances = []
    subscribeServerEvents('sess-A/with space', () => {})
    expect(MockEventSource.instances[0].url).toBe(
      '/api/event?sid=sess-A%2Fwith%20space',
    )
  })

  test('dispatches named SSE events (runtime.delta) to onEvent', () => {
    // Regression: server writes `event: runtime.delta`, only addEventListener
    // ('runtime.delta', ...) fires. onmessage must NOT receive these.
    MockEventSource.instances = []
    const onEvent = vi.fn()
    subscribeServerEvents('s1', onEvent)
    const es = MockEventSource.instances[0]
    es.dispatchNamed('runtime.delta', {
      type: 'runtime.delta',
      eventId: 'e1', ts: 1, seq: 1, sessionId: 's1', turnIndex: 0, delta: 'hi',
    })
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'runtime.delta', delta: 'hi' }),
    )
  })

  test('dispatches runtime.started and runtime.done named events', () => {
    MockEventSource.instances = []
    const onEvent = vi.fn()
    subscribeServerEvents('s1', onEvent)
    const es = MockEventSource.instances[0]
    es.dispatchNamed('runtime.started', {
      type: 'runtime.started',
      eventId: 'e1', ts: 1, seq: 2, sessionId: 's1', turnIndex: 0,
    })
    es.dispatchNamed('runtime.done', {
      type: 'runtime.done',
      eventId: 'e2', ts: 2, seq: 3, sessionId: 's1', turnIndex: 0,
    })
    const types = onEvent.mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types).toContain('runtime.started')
    expect(types).toContain('runtime.done')
  })

  test('dispatches instance.changed named events', () => {
    MockEventSource.instances = []
    const onEvent = vi.fn()
    subscribeServerEvents('s1', onEvent)
    const es = MockEventSource.instances[0]

    es.dispatchNamed('instance.changed', {
      type: 'instance.changed',
      eventId: 'e-instance',
      ts: 1,
      seq: 4,
      instanceId: 'inst_1',
      state: 'running',
      port: 9202,
      pid: 42,
      lastHeartbeatAt: '2026-08-04T00:00:00.000Z',
    })

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'instance.changed', instanceId: 'inst_1' }),
    )
  })

  test('parses failure logs but does not throw', () => {
    MockEventSource.instances = []
    const onEvent = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    subscribeServerEvents('s1', onEvent)
    const es = MockEventSource.instances[0]
    es.dispatchNamed('runtime.delta', 'not json' as unknown as ServerEvent)
    expect(onEvent).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  test('handle.close calls es.close', () => {
    MockEventSource.instances = []
    const handle = subscribeServerEvents(null, () => {})
    const es = MockEventSource.instances[0]
    handle.close()
    expect(es.close).toHaveBeenCalled()
  })

  test('onerror 触发 notifySseError(/event) 并报 reconnecting', () => {
    notifMock.error.mockReset()
    notifMock.error.mockImplementation(() => undefined)
    MockEventSource.instances = []
    const states: StreamState[] = []
    subscribeServerEvents('s1', () => {}, (s) => states.push(s))
    const es = MockEventSource.instances[0]
    es.onerror?.(new Event('error'))
    expect(notifMock.error).toHaveBeenCalledTimes(1)
    expect(notifMock.error.mock.calls[0][0].description).toContain('/event')
    expect(states.at(-1)).toBe('reconnecting')
  })

  // ========== 连接状态机 (onState 回调) ==========

  test('reports connecting on subscribe then connected on first open', () => {
    MockEventSource.instances = []
    const states: StreamState[] = []
    subscribeServerEvents('s1', () => {}, (s) => states.push(s))
    // 首次连接: 尚未 onopen, 先报 connecting
    expect(states[0]).toBe('connecting')
    const es = MockEventSource.instances[0]
    es.emitOpen()
    expect(states.at(-1)).toBe('connected')
  })

  test('reports reconnecting on first error then connected on reopen', () => {
    MockEventSource.instances = []
    const states: StreamState[] = []
    subscribeServerEvents('s1', () => {}, (s) => states.push(s))
    const es = MockEventSource.instances[0]
    es.emitOpen()
    es.onerror?.(new Event('error'))
    expect(states.at(-1)).toBe('reconnecting')
    es.emitOpen()
    expect(states.at(-1)).toBe('connected')
  })

  test('reports reconnecting up to 3 failures then error on the 4th', () => {
    MockEventSource.instances = []
    const states: StreamState[] = []
    subscribeServerEvents('s1', () => {}, (s) => states.push(s))
    const es = MockEventSource.instances[0]
    es.emitOpen()
    es.onerror?.(new Event('error'))
    es.onerror?.(new Event('error'))
    es.onerror?.(new Event('error'))
    // 连续失败 <= 3 次仍是 reconnecting (EventSource 自动重连中)
    expect(states.at(-1)).toBe('reconnecting')
    // 第 4 次失败 → error (UI 显示错误 + 手动重连)
    es.onerror?.(new Event('error'))
    expect(states.at(-1)).toBe('error')
  })
})