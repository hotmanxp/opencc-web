// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalFrame, WebTerminalInfo } from '../../../../shared/terminal.js'

/**
 * TerminalView 的 xterm 与 SSE 是外部依赖，这里整块替换掉：
 * 断言的是「帧 → xterm 调用」「键盘 → /write」「尺寸 → /resize」这些接线，
 * 而不是 xterm 自身的渲染（那要真浏览器，见 plan 的 ego-browser 验收）。
 */

const h = vi.hoisted(() => ({
  instances: [] as {
    cols: number
    rows: number
    options: Record<string, unknown>
    writes: string[]
    disposed: boolean
    focused: boolean
  }[],
  dataHandler: null as ((data: string) => void) | null,
  resizeCallbacks: [] as (() => void)[],
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols: number
    rows: number
    options: Record<string, unknown>
    writes: string[] = []
    disposed = false
    focused = false

    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
      this.cols = (options.cols as number) ?? 80
      this.rows = (options.rows as number) ?? 24
      h.instances.push(this)
    }

    loadAddon(): void {}
    open(): void {}
    write(data: string): void {
      this.writes.push(data)
    }
    reset(): void {
      this.writes.push('<reset>')
    }
    resize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
    }
    focus(): void {
      this.focused = true
    }
    dispose(): void {
      this.disposed = true
    }
    onData(callback: (data: string) => void): { dispose: () => void } {
      h.dataHandler = callback
      return { dispose: () => undefined }
    }
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    load(): void {}
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 100, rows: 30 }
    }
  },
}))

class MockEventSource {
  static instances: MockEventSource[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false

  constructor(readonly url: string) {
    MockEventSource.instances.push(this)
  }

  emit(frame: TerminalFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  close(): void {
    this.closed = true
  }
}

;(globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource

class FakeResizeObserver {
  constructor(callback: () => void) {
    h.resizeCallbacks.push(callback)
  }
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

const fetchMock = vi.fn(
  async (_url: string, _init?: RequestInit): Promise<Response> =>
    ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response,
)
;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

import { TerminalView } from './TerminalView.js'

const INFO: WebTerminalInfo = {
  id: 't-1',
  title: 'zsh',
  shell: { path: '/bin/zsh', name: 'zsh', args: ['-i'] },
  cwd: '/foo',
  cols: 80,
  rows: 24,
  state: 'running',
  exitCode: null,
}

function renderView(overrides: Partial<React.ComponentProps<typeof TerminalView>> = {}) {
  const onInfo = vi.fn()
  const view = render(
    <TerminalView
      sessionId="sess-1"
      info={INFO}
      visible
      maxCols={500}
      maxRows={200}
      scrollback={1000}
      onInfo={onInfo}
      {...overrides}
    />,
  )
  return { view, onInfo }
}

const flushWrites = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

describe('TerminalView', () => {
  beforeEach(() => {
    h.instances.length = 0
    h.dataHandler = null
    h.resizeCallbacks.length = 0
    MockEventSource.instances.length = 0
    fetchMock.mockClear()
    // happy-dom 没有布局，clientWidth/Height 恒为 0 → fit 会被跳过；这里给个非零尺寸。
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 })
  })

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
  })

  it('挂载即以 props 建 xterm，并打开该终端的 SSE 流', () => {
    renderView()
    expect(h.instances).toHaveLength(1)
    expect(h.instances[0].options.scrollback).toBe(1000)
    expect(h.instances[0].options.cursorBlink).toBe(true)
    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0].url).toBe('/api/terminal/t-1/events?sessionId=sess-1')
  })

  it('snapshot 帧：reset + 按 info 尺寸 resize + 写屏 + 回填 tab', async () => {
    const { onInfo } = renderView()
    const term = h.instances[0]
    const info: WebTerminalInfo = { ...INFO, cols: 120, rows: 40, title: '构建' }
    await act(async () => {
      MockEventSource.instances[0].emit({ type: 'snapshot', screen: 'SNAPSHOT-TEXT', info })
    })
    expect(term.writes).toContain('<reset>')
    expect(term.writes).toContain('SNAPSHOT-TEXT')
    expect([term.cols, term.rows]).toEqual([120, 40])
    expect(onInfo).toHaveBeenCalledWith(info)
  })

  it('output 帧合帧后写入 xterm', async () => {
    renderView()
    await act(async () => {
      MockEventSource.instances[0].emit({ type: 'output', data: 'chunk-1' })
      MockEventSource.instances[0].emit({ type: 'output', data: 'chunk-2' })
      await flushWrites()
    })
    expect(h.instances[0].writes.join('')).toContain('chunk-1chunk-2')
  })

  it('state 帧：尺寸变化同步 xterm，退出后禁用输入', async () => {
    const { onInfo } = renderView()
    const term = h.instances[0]
    await act(async () => {
      MockEventSource.instances[0].emit({ type: 'state', info: { ...INFO, cols: 132, rows: 43 } })
    })
    expect([term.cols, term.rows]).toEqual([132, 43])
    expect(onInfo).toHaveBeenCalled()

    await act(async () => {
      MockEventSource.instances[0].emit({
        type: 'state',
        info: { ...INFO, state: 'exited', exitCode: 1 },
      })
    })
    expect(term.options.disableStdin).toBe(true)
  })

  it('键盘输入原样写到 /write（含控制字符）', async () => {
    renderView()
    await act(async () => {
      h.dataHandler?.('ls\r')
      h.dataHandler?.('\u0003')
    })
    const writeCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/terminal/t-1/write'))
    expect(writeCalls.length).toBeGreaterThanOrEqual(1)
    expect(String(writeCalls[0][0])).toContain('sessionId=sess-1')
    expect((writeCalls[0][1] as RequestInit).body).toBe(JSON.stringify({ data: 'ls\r' }))
  })

  it('不可见的 tab 不开 SSE', () => {
    renderView({ visible: false })
    expect(MockEventSource.instances).toHaveLength(0)
  })

  it('已退出的终端仍拉一次快照恢复最后一屏，且流结束不报断线', async () => {
    const exited: WebTerminalInfo = { ...INFO, state: 'exited', exitCode: 0 }
    renderView({ info: exited })
    expect(MockEventSource.instances).toHaveLength(1)

    await act(async () => {
      MockEventSource.instances[0].emit({ type: 'snapshot', screen: 'LAST-SCREEN', info: exited })
      // 服务端交付快照后立即结束这条流 —— 浏览器会报 error，不该被当成连接故障。
      MockEventSource.instances[0].onerror?.({})
    })
    expect(h.instances[0].writes).toContain('LAST-SCREEN')
    expect(screen.queryByTestId('terminal-reconnect-t-1')).toBeNull()
  })

  it('尺寸变化按 maxCols/maxRows 夹取后上报 /resize', async () => {
    renderView({ maxCols: 90, maxRows: 25 })
    // 触发 ResizeObserver 回调（clientWidth 已给了 800×400，proposeDimensions 返回 100×30）
    await act(async () => {
      for (const callback of h.resizeCallbacks) callback()
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect([h.instances[0].cols, h.instances[0].rows]).toEqual([90, 25])
    const resizeCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/resize'))
    expect(resizeCalls).toHaveLength(1)
    expect((resizeCalls[0][1] as RequestInit).body).toBe(JSON.stringify({ cols: 90, rows: 25 }))
  })

  it('卸载只释放本地资源：dispose xterm + 关流，不调 /close', async () => {
    const { view } = renderView()
    const source = MockEventSource.instances[0]
    view.unmount()
    expect(h.instances[0].disposed).toBe(true)
    expect(source.closed).toBe(true)
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/close'))).toBe(false)
  })

  it('SSE 断开时给出重连按钮，点击后重开一条流', async () => {
    renderView()
    await act(async () => {
      MockEventSource.instances[0].onerror?.({})
    })
    const reconnect = screen.getByTestId('terminal-reconnect-t-1')
    await act(async () => {
      fireEvent.click(reconnect)
    })
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(2))
  })
})