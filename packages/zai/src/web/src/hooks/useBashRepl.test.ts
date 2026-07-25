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

/** 构造一个 ok 的 fetch 响应,带 entries。 */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

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

describe('useBashRepl — topCommands (Task 4)', () => {
  beforeEach(() => {
    MockEventSource.instances.length = 0
    fetchMock.mockReset()
  })

  it('sessionId 建立后自动调一次 fetchTopCommands', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        entries: [
          { command: 'ls', count: 5 },
          { command: 'pwd', count: 2 },
        ],
      }),
    )
    const { result } = renderHook(() => useBashRepl('sess-1', '/tmp'))
    // microtask flush 后 state 更新
    await act(async () => { await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledWith('/api/bash/history/top10')
    expect(result.current.topCommands).toHaveLength(2)
    expect(result.current.topCommands[0]).toEqual({ command: 'ls', count: 5 })
  })

  it('fetchTopCommands 失败时 topCommands 保持空数组 (不抛)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    const { result } = renderHook(() => useBashRepl('sess-1', '/tmp'))
    await act(async () => { await Promise.resolve() })
    expect(result.current.topCommands).toEqual([])
  })

  it('sessionId 从 null → 设置,触发 fetch', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ entries: [{ command: 'git status', count: 1 }] }),
    )
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string | null }) => useBashRepl(sid, '/tmp'),
      { initialProps: { sid: null as string | null } },
    )
    await act(async () => { await Promise.resolve() })
    expect(fetchMock).not.toHaveBeenCalled()
    rerender({ sid: 'sess-X' })
    await act(async () => { await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.topCommands[0].command).toBe('git status')
  })

  it('refreshTopCommands 手动触发 fetch', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ entries: [{ command: 'echo hi', count: 1 }] }),
    )
    const { result } = renderHook(() => useBashRepl('sess-1', '/tmp'))
    await act(async () => { await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      await result.current.refreshTopCommands()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refreshTopCommands 失败静默', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useBashRepl('sess-1', '/tmp'))
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      await result.current.refreshTopCommands()
    })
    // 不抛即可;topCommands 仍为空
    expect(result.current.topCommands).toEqual([])
  })
})