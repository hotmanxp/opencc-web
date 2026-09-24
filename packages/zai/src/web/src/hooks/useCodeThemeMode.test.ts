// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useCodeThemeMode } from './useCodeThemeMode.js'

function setHtmlTheme(mode: 'dark' | 'light' | null) {
  if (mode === null) delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = mode
}

describe('useCodeThemeMode', () => {
  afterEach(() => {
    act(() => setHtmlTheme(null))
  })

  it('reads the initial mode from <html data-theme>', () => {
    setHtmlTheme('light')
    expect(renderHook(() => useCodeThemeMode()).result.current).toBe('light')
  })

  it('falls back to dark when the attribute is absent', () => {
    setHtmlTheme(null)
    expect(renderHook(() => useCodeThemeMode()).result.current).toBe('dark')
  })

  it('reacts to a data-theme mutation (theme toggle)', async () => {
    setHtmlTheme('dark')
    const { result } = renderHook(() => useCodeThemeMode())
    expect(result.current).toBe('dark')
    // MutationObserver delivery is a microtask — flush it inside act().
    await act(async () => {
      setHtmlTheme('light')
    })
    expect(result.current).toBe('light')
  })
})