// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SettingsButton from '../../src/web/src/components/SettingsButton.js'
import { useAppStore } from '../../src/web/src/store/useAppStore.js'

beforeEach(() => {
  useAppStore.setState({
    settingsDrawerOpen: false,
    openSettingsDrawer: useAppStore.getState().openSettingsDrawer,
    closeSettingsDrawer: useAppStore.getState().closeSettingsDrawer,
    setSettingsTheme: useAppStore.getState().setSettingsTheme,
  } as any)
})

describe('SettingsButton', () => {
  it('点击后 settingsDrawerOpen 变 true', () => {
    render(<SettingsButton />)
    const btn = screen.getByTestId('agent-settings-button')
    fireEvent.click(btn)
    expect(useAppStore.getState().settingsDrawerOpen).toBe(true)
  })

  it('初始 settingsDrawerOpen === false', () => {
    render(<SettingsButton />)
    expect(useAppStore.getState().settingsDrawerOpen).toBe(false)
  })
})
