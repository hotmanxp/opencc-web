// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useEffectiveTheme } from './useEffectiveTheme.js'
import { useAppStore } from '../store/useAppStore.js'

type Listener = (e: MediaQueryListEvent) => void

function mockMatchMedia(matches: boolean) {
  const listeners: Listener[] = []
  const mql = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: 'change', cb: Listener) => { listeners.push(cb) },
    removeEventListener: (_: 'change', cb: Listener) => {
      const i = listeners.indexOf(cb)
      if (i >= 0) listeners.splice(i, 1)
    },
    addListener: (cb: Listener) => { listeners.push(cb) },
    removeListener: (cb: Listener) => {
      const i = listeners.indexOf(cb)
      if (i >= 0) listeners.splice(i, 1)
    },
    dispatchEvent: () => true,
  } as unknown as MediaQueryList
  vi.spyOn(window, 'matchMedia').mockImplementation(() => mql)
  return { mql, fire: (next: boolean) => listeners.forEach((l) => l({ matches: next } as MediaQueryListEvent)) }
}

describe('useEffectiveTheme', () => {
  beforeEach(() => {
    act(() => { useAppStore.setState({ settingsTheme: 'auto' }) })
  })
  afterEach(() => {
    act(() => { vi.restoreAllMocks() })
  })

  it('returns dark for settingsTheme=dark regardless of system', () => {
    mockMatchMedia(false)
    const { result } = renderHook(() => useEffectiveTheme())
    act(() => { useAppStore.setState({ settingsTheme: 'dark' }) })
    expect(result.current).toBe('dark')
  })

  it('returns light for settingsTheme=light regardless of system', () => {
    mockMatchMedia(true)
    const { result } = renderHook(() => useEffectiveTheme())
    act(() => { useAppStore.setState({ settingsTheme: 'light' }) })
    expect(result.current).toBe('light')
  })

  it('auto + system dark → dark', () => {
    mockMatchMedia(true)
    const { result } = renderHook(() => useEffectiveTheme())
    expect(result.current).toBe('dark')
  })

  it('auto + system light → light', () => {
    mockMatchMedia(false)
    const { result } = renderHook(() => useEffectiveTheme())
    expect(result.current).toBe('light')
  })

  it('high-contrast follows auto semantics (system light → light)', () => {
    mockMatchMedia(false)
    const { result } = renderHook(() => useEffectiveTheme())
    expect(result.current).toBe('light')
  })

  it('falls back to dark when matchMedia is unavailable', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue(null as unknown as MediaQueryList)
    const { result } = renderHook(() => useEffectiveTheme())
    expect(result.current).toBe('dark')
  })

  it('reacts to system change while auto', () => {
    const { fire } = mockMatchMedia(true)
    const { result } = renderHook(() => useEffectiveTheme())
    expect(result.current).toBe('dark')
    act(() => { fire(false) })
    expect(result.current).toBe('light')
  })
})
