// packages/zai/test/web/useScrollFollow.test.tsx
// @vitest-environment happy-dom
//
// 验证 useScrollFollow: 通过监听"用户输入手势"(wheel / touchstart /
// keydown) 检测用户是否在主动查看历史。scroll 事件**不算**用户操作 —
// 它也会被 AI 自己的 scrollIntoView 触发, 不能拿来判断。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createRef, type RefObject } from 'react'
import { useScrollFollow } from '../../src/web/src/hooks/useScrollFollow.js'

function makeContainer(): { ref: RefObject<HTMLElement>; container: HTMLElement } {
  const container = document.createElement('div')
  const ref = createRef<HTMLElement>()
  ;(ref as { current: HTMLElement | null }).current = container
  return { ref, container }
}

describe('useScrollFollow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('初始 (无用户操作) locked=false', () => {
    const { ref } = makeContainer()
    const { result } = renderHook(() => useScrollFollow(ref))
    expect(result.current).toBe(false)
  })

  it('AI 触发的 scroll 事件不会锁 (关键: 必须区分程序滚动)', () => {
    const { ref, container } = makeContainer()
    const { result } = renderHook(() => useScrollFollow(ref))
    act(() => {
      // scrollIntoView / scrollTo / 设置 scrollTop 都会 fire 这个事件,
      // 不能用它判断"用户在动"。
      container.dispatchEvent(new Event('scroll'))
    })
    expect(result.current).toBe(false)
  })

  it('wheel 手势 → locked=true', () => {
    const { ref, container } = makeContainer()
    const { result } = renderHook(() => useScrollFollow(ref))
    act(() => {
      container.dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    expect(result.current).toBe(true)
  })

  it('touchstart 手势 → locked=true', () => {
    const { ref, container } = makeContainer()
    const { result } = renderHook(() => useScrollFollow(ref))
    act(() => {
      container.dispatchEvent(new Event('touchstart', { bubbles: true }))
    })
    expect(result.current).toBe(true)
  })

  it('键盘 PageUp/PageDown/ArrowKeys/Home/End → locked=true', () => {
    const { ref, container } = makeContainer()
    const { result } = renderHook(() => useScrollFollow(ref))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }))
    })
    expect(result.current).toBe(true)
  })

  it('键盘普通输入 (a/z/1) 不应锁 — 那些不是滚动意图', () => {
    const { ref, container } = makeContainer()
    const { result } = renderHook(() => useScrollFollow(ref))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    })
    expect(result.current).toBe(false)
  })

  it('5s 内无新手势 → locked 回到 false', () => {
    const { ref, container } = makeContainer()
    const { result } = renderHook(() => useScrollFollow(ref))
    act(() => {
      container.dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    expect(result.current).toBe(true)
    act(() => {
      vi.advanceTimersByTime(4999)
    })
    expect(result.current).toBe(true)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(false)
  })

  it('5s 内连续手势 → 计时器持续重置,locked 一直为 true', () => {
    const { ref, container } = makeContainer()
    const { result } = renderHook(() => useScrollFollow(ref))
    // t=0 第一次手势
    act(() => {
      container.dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    expect(result.current).toBe(true)
    // t=4000 第二次手势 → timer 重置
    act(() => {
      vi.advanceTimersByTime(4000)
      container.dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    expect(result.current).toBe(true)
    // t=8000 (距第二次手势 4s) → 还在 5s 内,仍 true
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(result.current).toBe(true)
    // t=9000 (距第二次手势 5s) → 到期,变 false
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(false)
  })

  it('unmount 时清理 timer 与 listeners,无泄漏', () => {
    const { ref, container } = makeContainer()
    const { result, unmount } = renderHook(() => useScrollFollow(ref))
    act(() => {
      container.dispatchEvent(new Event('wheel', { bubbles: true }))
    })
    expect(result.current).toBe(true)
    unmount()
    expect(() => {
      vi.advanceTimersByTime(5000)
    }).not.toThrow()
  })

  it('ref 未挂载时安全返回 false', () => {
    const ref = createRef<HTMLElement>()
    const { result } = renderHook(() => useScrollFollow(ref))
    expect(result.current).toBe(false)
  })
})