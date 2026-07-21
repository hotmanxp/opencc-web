// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAgentStore } from '../store/useAgentStore.js'
import { STORAGE_KEYS } from '../components/splitPane/shared.js'
import { useSplitPaneCompactLock } from './useSplitPaneCompactLock.js'

beforeEach(() => {
  localStorage.clear()
  useAgentStore.setState({ transcriptCollapsed: false })
})

afterEach(() => {
  localStorage.clear()
})

describe('useSplitPaneCompactLock', () => {
  test('splitPaneOpen=false → isLocked is false and transcriptCollapsed untouched', () => {
    const { result } = renderHook(() => useSplitPaneCompactLock())
    expect(result.current.isLocked).toBe(false)
    expect(useAgentStore.getState().transcriptCollapsed).toBe(false)
  })

  test('splitPaneOpen: false → true forces transcriptCollapsed=true and isLocked=true', () => {
    const { result } = renderHook(() => useSplitPaneCompactLock())
    expect(result.current.isLocked).toBe(false)

    act(() => {
      localStorage.setItem(STORAGE_KEYS.open, 'true')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEYS.open,
          newValue: 'true',
        }),
      )
    })

    expect(useAgentStore.getState().transcriptCollapsed).toBe(true)
    expect(result.current.isLocked).toBe(true)
  })

  test('while locked, external setTranscriptCollapsed(false) is reverted to true', () => {
    const { result } = renderHook(() => useSplitPaneCompactLock())
    act(() => {
      localStorage.setItem(STORAGE_KEYS.open, 'true')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEYS.open,
          newValue: 'true',
        }),
      )
    })
    expect(result.current.isLocked).toBe(true)

    act(() => {
      useAgentStore.getState().setTranscriptCollapsed(false)
    })

    expect(useAgentStore.getState().transcriptCollapsed).toBe(true)
  })

  test('splitPaneOpen: true → false leaves transcriptCollapsed locked at true (hook does not undo on exit)', () => {
    const { result } = renderHook(() => useSplitPaneCompactLock())
    act(() => {
      localStorage.setItem(STORAGE_KEYS.open, 'true')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEYS.open,
          newValue: 'true',
        }),
      )
    })
    expect(useAgentStore.getState().transcriptCollapsed).toBe(true)
    expect(result.current.isLocked).toBe(true)

    // 关闭分屏 → hook 不主动回写,但 transcriptCollapsed 仍维持在
    // lock 期间的 true (hook 唯一会 setTranscriptCollapsed 的两条 effect
    // 都在 splitPaneOpen=true 时才执行).
    act(() => {
      localStorage.setItem(STORAGE_KEYS.open, 'false')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEYS.open,
          newValue: 'false',
        }),
      )
    })

    expect(result.current.isLocked).toBe(false)
    // transcriptCollapsed 维持为 true (hook 不再干预).
    expect(useAgentStore.getState().transcriptCollapsed).toBe(true)

    // 退出 lock 后再 set false,hook 不再反向回写.
    act(() => {
      useAgentStore.getState().setTranscriptCollapsed(false)
    })
    expect(useAgentStore.getState().transcriptCollapsed).toBe(false)
  })
})
