// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplEvent } from '../../shared/repl.js'

// Mock EventSource — 测试环境无原生 EventSource
class MockEventSource {
  url: string
  readyState = 0
  onopen: ((ev: any) => void) | null = null
  onerror: ((ev: any) => void) | null = null
  onmessage: ((ev: any) => void) | null = null
  closed = false
  static instances: MockEventSource[] = []
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  close() { this.closed = true; this.readyState = 2 }
  emit(ev: ReplEvent) { this.onmessage?.({ data: JSON.stringify(ev) }) }
  emitOpen() { this.readyState = 1; this.onopen?.({}) }
  emitError() { this.onerror?.({}) }
}
;(globalThis as any).EventSource = MockEventSource

const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock

import { useBashRepl } from './useBashRepl.js'

describe('useBashRepl', () => {
  beforeEach(() => {
    MockEventSource.instances.length = 0
    fetchMock.mockReset()
  })

  it('mount 时建立 EventSource', () => {
    renderHook(() => useBashRepl('sess-1', '/tmp'))
    expect(MockEventSource.instances.length).toBe(1)
    expect(MockEventSource.instances[0].url).toContain('/api/bash/repl/sess-1/events')
  })

  it('sessionId 变化关闭旧 EventSource、建新的', () => {
    const { rerender } = renderHook(({ sid }) => useBashRepl(sid, '/tmp'), {
      initialProps: { sid: 'sess-1' },
    })
    expect(MockEventSource.instances.length).toBe(1)
    rerender({ sid: 'sess-2' })
    expect(MockEventSource.instances[0].closed).toBe(true)
    expect(MockEventSource.instances.length).toBe(2)
    expect(MockEventSource.instances[1].url).toContain('sess-2')
  })

  it('SSE message 推入 events 数组', () => {
    const { result } = renderHook(() => useBashRepl('sess-1', '/tmp'))
    const es = MockEventSource.instances[0]
    act(() => { es.emit({ kind: 'stdout', execId: 'e-1', chunk: 'hello', ts: 1 }) })
    expect(result.current.events).toHaveLength(1)
    expect(result.current.events[0].kind).toBe('stdout')
  })

  it('exit event 设置 busy=false', () => {
    const { result } = renderHook(() => useBashRepl('sess-1', '/tmp'))
    act(() => {
      const es = MockEventSource.instances[0]
      es.emit({ kind: 'exit', execId: 'e-1', code: 0, signal: null, ts: 1 })
    })
    expect(result.current.busy).toBe(false)
    expect(result.current.currentExecId).toBe(null)
  })

  it('onopen 设置 connected=true', () => {
    const { result } = renderHook(() => useBashRepl('sess-1', '/tmp'))
    act(() => { MockEventSource.instances[0].emitOpen() })
    expect(result.current.connected).toBe(true)
  })

  it('unmount 时关闭 EventSource', () => {
    const { unmount } = renderHook(() => useBashRepl('sess-1', '/tmp'))
    expect(MockEventSource.instances.length).toBe(1)
    unmount()
    expect(MockEventSource.instances[0].closed).toBe(true)
  })
})