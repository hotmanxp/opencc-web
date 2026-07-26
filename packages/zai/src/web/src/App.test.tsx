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

describe('App theme wiring', () => {
  beforeEach(() => {
    useAppStore.setState({ settingsTheme: 'auto' })
    document.documentElement.dataset.theme = ''
  })
  afterEach(() => {
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
