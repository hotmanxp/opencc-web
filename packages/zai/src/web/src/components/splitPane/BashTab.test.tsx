// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplEvent } from '../../../shared/repl.js'

class MockEventSource {
  url: string
  readyState = 0
  onopen: ((ev: any) => void) | null = null
  onmessage: ((ev: any) => void) | null = null
  onerror: ((ev: any) => void) | null = null
  closed = false
  static instances: MockEventSource[] = []
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
    setTimeout(() => { this.onopen?.({}); this.readyState = 1 }, 0)
  }
  close() { this.closed = true; this.readyState = 2 }
  emit(ev: ReplEvent) { this.onmessage?.({ data: JSON.stringify(ev) }) }
}
;(globalThis as any).EventSource = MockEventSource

const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock

import { BashTab } from './BashTab.js'

describe('BashTab', () => {
  beforeEach(() => {
    MockEventSource.instances.length = 0
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('输入框显示 cwd 路径', () => {
    render(<BashTab sessionId="sess-1" cwd="/foo/bar" />)
    expect(screen.getByText('/foo/bar')).toBeDefined()
  })

  it('Enter 触发 exec', async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true, execId: 'e-1' }) })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    const input = screen.getByPlaceholderText(/输入/)
    await act(async () => {
      fireEvent.change(input, { target: { value: 'echo hi' } })
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/bash/repl/sess-1/exec')
    expect(JSON.parse(init.body)).toEqual({ command: 'echo hi', cwd: '/foo' })
  })

  it('SSE stdout 渲染到 output area', async () => {
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
      const es = MockEventSource.instances[0]
      es.emit({ kind: 'stdout', execId: 'e-1', chunk: 'rendered-output', ts: 1 })
    })
    expect(screen.getByText('rendered-output')).toBeDefined()
  })

  it('SSE exit 事件显示分隔行', async () => {
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
      const es = MockEventSource.instances[0]
      es.emit({ kind: 'exit', execId: 'e-1', code: 0, signal: null, ts: 1 })
    })
    expect(screen.getByText(/exit 0/)).toBeDefined()
  })

  it('abort 按钮：busy=false 时不渲染，busy=true 时渲染', async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true, execId: 'e-1' }) })
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true }) })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })

    expect(screen.queryByText(/^终止$/)).toBeNull()

    const input = screen.getByPlaceholderText(/输入/)
    await act(async () => {
      fireEvent.change(input, { target: { value: 'sleep 100' } })
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    })

    await waitFor(() => expect(screen.queryByText(/^终止$/)).not.toBeNull())

    await act(async () => {
      fireEvent.click(screen.getByText(/^终止$/))
    })
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c: any) => c[0].includes('/abort'))).toBe(true)
    })
  })

  it('busy=true 时输入框禁用', async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true, execId: 'e-1' }) })
    render(<BashTab sessionId="sess-1" cwd="/foo" />)
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })

    const input = screen.getByPlaceholderText(/输入/) as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: 'sleep 100' } })
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    })
    await waitFor(() => expect(input.disabled).toBe(true))
  })
})