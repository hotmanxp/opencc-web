import { describe, expect, test, vi } from 'vitest'
import type { ServerEvent } from '../../../shared/events.js'

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
  test('connects to /api/event', () => {
    MockEventSource.instances = []
    subscribeServerEvents(() => {})
    expect(MockEventSource.instances[0].url).toBe('/api/event')
  })

  test('dispatches named SSE events (runtime.delta) to onEvent', () => {
    // Regression: server writes `event: runtime.delta`, only addEventListener
    // ('runtime.delta', ...) fires. onmessage must NOT receive these.
    MockEventSource.instances = []
    const onEvent = vi.fn()
    subscribeServerEvents(onEvent)
    const es = MockEventSource.instances[0]
    es.dispatchNamed('runtime.delta', {
      type: 'runtime.delta',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0, delta: 'hi',
    })
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'runtime.delta', delta: 'hi' }),
    )
  })

  test('dispatches runtime.started and runtime.done named events', () => {
    MockEventSource.instances = []
    const onEvent = vi.fn()
    subscribeServerEvents(onEvent)
    const es = MockEventSource.instances[0]
    es.dispatchNamed('runtime.started', {
      type: 'runtime.started',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
    })
    es.dispatchNamed('runtime.done', {
      type: 'runtime.done',
      eventId: 'e2', ts: 2, sessionId: 's1', turnIndex: 0,
    })
    const types = onEvent.mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types).toContain('runtime.started')
    expect(types).toContain('runtime.done')
  })

  test('parses failure logs but does not throw', () => {
    MockEventSource.instances = []
    const onEvent = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    subscribeServerEvents(onEvent)
    const es = MockEventSource.instances[0]
    es.dispatchNamed('runtime.delta', 'not json' as unknown as ServerEvent)
    expect(onEvent).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  test('handle.close calls es.close', () => {
    MockEventSource.instances = []
    const handle = subscribeServerEvents(() => {})
    const es = MockEventSource.instances[0]
    handle.close()
    expect(es.close).toHaveBeenCalled()
  })

  test('onerror 触发 notifySseError(/event) 并调原 onError', () => {
    notifMock.error.mockReset()
    notifMock.error.mockImplementation(() => undefined)
    MockEventSource.instances = []
    const onError = vi.fn()
    subscribeServerEvents(() => {}, onError)
    const es = MockEventSource.instances[0]
    es.onerror?.(new Event('error'))
    expect(notifMock.error).toHaveBeenCalledTimes(1)
    expect(notifMock.error.mock.calls[0][0].description).toContain('/event')
    expect(onError).toHaveBeenCalledTimes(1)
  })
})