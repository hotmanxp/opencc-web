// @vitest-environment happy-dom
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVisualViewportHeight } from './useVisualViewportHeight'

describe('useVisualViewportHeight', () => {
  let listeners: Array<() => void>

  beforeEach(() => {
    listeners = []
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 800,
        addEventListener: (_ev: string, cb: () => void) => { listeners.push(cb) },
        removeEventListener: (_ev: string, cb: () => void) => {
          listeners = listeners.filter((f) => f !== cb)
        },
      },
    })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
  })

  afterEach(() => {
    delete (window as any).visualViewport
  })

  test('returns visualViewport.height on mount', () => {
    const { result } = renderHook(() => useVisualViewportHeight())
    expect(result.current).toBe(800)
  })

  test('updates on visualViewport resize event', () => {
    const { result } = renderHook(() => useVisualViewportHeight())
    expect(result.current).toBe(800)
    act(() => {
      ;(window as any).visualViewport.height = 500
      listeners.forEach((cb) => cb())
    })
    expect(result.current).toBe(500)
  })

  test('falls back to window.innerHeight when visualViewport is absent', () => {
    delete (window as any).visualViewport
    const { result } = renderHook(() => useVisualViewportHeight())
    expect(result.current).toBe(900)
  })

  test('removes listener on unmount', () => {
    const { unmount } = renderHook(() => useVisualViewportHeight())
    expect(listeners.length).toBe(1)
    unmount()
    expect(listeners.length).toBe(0)
  })
})