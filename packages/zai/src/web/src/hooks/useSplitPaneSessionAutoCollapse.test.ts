// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { STORAGE_KEYS } from '../components/splitPane/shared.js'
import { useSplitPaneSessionAutoCollapse } from './useSplitPaneSessionAutoCollapse.js'

function setSplitPaneOpen(value: boolean) {
  localStorage.setItem(STORAGE_KEYS.open, JSON.stringify(value))
  window.dispatchEvent(
    new StorageEvent('storage', { key: STORAGE_KEYS.open, newValue: JSON.stringify(value) }),
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('useSplitPaneSessionAutoCollapse', () => {
  test('splitPaneOpen=false keeps manual collapsed state (default true)', () => {
    const { result } = renderHook(() =>
      useSplitPaneSessionAutoCollapse({ splitPaneOpen: false }),
    )
    expect(result.current.collapsed).toBe(true)
  })

  test('splitPaneOpen=true forces collapsed=true on mount', () => {
    const { result } = renderHook(() =>
      useSplitPaneSessionAutoCollapse({ splitPaneOpen: true }),
    )
    expect(result.current.collapsed).toBe(true)
  })

  test('expand() flips to false and arms a default-10s auto-collapse timer', () => {
    const { result } = renderHook(() =>
      useSplitPaneSessionAutoCollapse({ splitPaneOpen: true }),
    )
    act(() => {
      result.current.expand()
    })
    expect(result.current.collapsed).toBe(false)

    act(() => {
      vi.advanceTimersByTime(9_999)
    })
    expect(result.current.collapsed).toBe(false)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.collapsed).toBe(true)
  })

  test('schedule() resets the running timer', () => {
    const { result } = renderHook(() =>
      useSplitPaneSessionAutoCollapse({ splitPaneOpen: true, timeoutMs: 100 }),
    )
    act(() => {
      result.current.expand()
    })
    act(() => {
      vi.advanceTimersByTime(60)
    })
    act(() => {
      result.current.schedule()
    })
    act(() => {
      vi.advanceTimersByTime(60)
    })
    // After 60ms (still under fresh 100ms arming), should still be expanded
    expect(result.current.collapsed).toBe(false)

    act(() => {
      vi.advanceTimersByTime(40)
    })
    // Now 100ms past the last schedule() → should collapse
    expect(result.current.collapsed).toBe(true)
  })

  test('splitPaneOpen goes false while timer running → timer is cleared and state preserved', () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) =>
        useSplitPaneSessionAutoCollapse({ splitPaneOpen: open, timeoutMs: 100 }),
      { initialProps: { open: true } },
    )
    act(() => {
      result.current.expand()
    })
    expect(result.current.collapsed).toBe(false)

    rerender({ open: false })
    // No forced collapse on exit per spec §4 + §6.5
    expect(result.current.collapsed).toBe(false)

    // Even past original timer deadline, no collapse happens because
    // splitPaneOpen=false → effect cleanup cleared the timeout.
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(result.current.collapsed).toBe(false)
  })

  test('unmount while timer running → no late collapse (no setState on unmounted)', () => {
    const { result, unmount } = renderHook(() =>
      useSplitPaneSessionAutoCollapse({ splitPaneOpen: true, timeoutMs: 100 }),
    )
    act(() => {
      result.current.expand()
    })
    unmount()
    act(() => {
      vi.advanceTimersByTime(500)
    })
    // No throw, no state update.
  })

  test('ignores storage event when caller already passes splitPaneOpen from same source', () => {
    // This test verifies the hook only depends on the boolean arg, NOT on
    // listening to storage events itself. (Mounting argument = false must
    // not flip back to true when localStorage changes mid-test.)
    const { result } = renderHook(() =>
      useSplitPaneSessionAutoCollapse({ splitPaneOpen: false }),
    )
    expect(result.current.collapsed).toBe(true)
    setSplitPaneOpen(true)
    expect(result.current.collapsed).toBe(true) // unchanged, hook doesn't auto-track
  })
})
