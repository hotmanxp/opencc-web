// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const notifMock = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('antd', () => ({ notification: notifMock }))

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
}
vi.stubGlobal('EventSource', MockEventSource)

import { useSse } from './sse.js'
import { __resetThrottleForTests } from './apiError.js'

describe('useSse', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    notifMock.error.mockReset()
    notifMock.error.mockImplementation(() => undefined)
    __resetThrottleForTests()
  })

  test('onerror 在 done===false 时触发 notify 并调 onEnd', () => {
    const onEnd = vi.fn()
    renderHook(() => useSse('/install/resource?x=1', () => {}, onEnd))
    const es = MockEventSource.instances[0]
    act(() => es.onerror?.(new Event('error')))
    expect(notifMock.error).toHaveBeenCalledTimes(1)
    expect(notifMock.error.mock.calls[0][0].message).toContain('SSE')
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  test('onerror 在已收到 exit 后静默(不通知,仍调 onEnd)', () => {
    const onEnd = vi.fn()
    renderHook(() => useSse('/install/resource?x=2', () => {}, onEnd))
    const es = MockEventSource.instances[0]
    act(() => {
      es.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 0 }) })
    })
    act(() => es.onerror?.(new Event('error')))
    expect(notifMock.error).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
})
