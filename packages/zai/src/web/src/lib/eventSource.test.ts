import { describe, expect, test, vi } from 'vitest'
import type { ServerEvent } from '../../../shared/events.js'

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  close = vi.fn()
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  emit(data: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(data) })
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

  test('parses incoming message and dispatches', () => {
    MockEventSource.instances = []
    const onEvent = vi.fn()
    subscribeServerEvents(onEvent)
    const es = MockEventSource.instances[0]
    es.emit({
      type: 'server.connected',
      eventId: 'e1', ts: 1, sessionId: null,
    })
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'server.connected' }))
  })

  test('parses failure logs but does not throw', () => {
    MockEventSource.instances = []
    const onEvent = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    subscribeServerEvents(onEvent)
    const es = MockEventSource.instances[0]
    es.onmessage?.({ data: 'not json' })
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
})
