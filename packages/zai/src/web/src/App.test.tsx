// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { render } from '@testing-library/react'
import App from './App.js'
import { useAppStore } from './store/useAppStore.js'

function mockMatchMedia(matches: boolean) {
  const mql = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  } as unknown as MediaQueryList
  vi.spyOn(window, 'matchMedia').mockImplementation(() => mql)
}

// App 渲染整棵树,useEventStream 的 effect 会走 subscribeServerEvents →
// `new EventSource(url)`。happy-dom 不提供 EventSource global,缺了它 4 条
// 主题用例全挂在 "EventSource is not defined",还会在 react-dom 的
// flushPassiveEffects 里连环抛 "Should not already be working"。
// 本文件只断言主题,不需要真的 SSE 连接 —— 空壳够用(同 lib/eventSource.test.ts
// 的 MockEventSource 思路,那边才需要 addEventListener 派发事件)。
class NoopEventSource {
  close = vi.fn()
  onmessage: unknown = null
  onopen: unknown = null
  onerror: unknown = null
  addEventListener() {}
  removeEventListener() {}
}

describe('App theme wiring', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', NoopEventSource)
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
    useAppStore.setState({ settingsTheme: 'auto' })
    document.documentElement.dataset.theme = ''
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.documentElement.dataset.theme = ''
  })

  it('auto + system dark → dataset.theme=dark', () => {
    mockMatchMedia(true)
    render(<App />)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('auto + system light → dataset.theme=light', () => {
    mockMatchMedia(false)
    render(<App />)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('settingsTheme=light overrides system dark', () => {
    mockMatchMedia(true)
    useAppStore.setState({ settingsTheme: 'light' })
    render(<App />)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('settingsTheme=dark overrides system light', () => {
    mockMatchMedia(false)
    useAppStore.setState({ settingsTheme: 'dark' })
    render(<App />)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
