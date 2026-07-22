// packages/zai/test/web/useAutoScrollToBottom.test.tsx
// @vitest-environment happy-dom
//
// useAutoScrollToBottom: 给一个 scroll container ref, 暴露 scrollToBottom 回调。
// 调用方把回调放进 useEffect([messages, pendingAsk, ...]) 里, hook 内部决定是否
// 真的执行 scrollIntoView:
//
//   - 通过 ref 拿容器 scrollTop / scrollHeight / clientHeight, 计算
//     distanceToBottomPx = scrollHeight - scrollTop - clientHeight
//   - 用 useRef 追踪 prevLength, 首次 = -1 (初始化强制跟随)
//   - 用 useScrollFollow 拿用户主动滚动锁
//   - 调 decideAutoScroll 决定是否真的 scrollTo({ top: scrollHeight })
//
// 测试覆盖三种调用场景:
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createRef } from 'react'
import { useAutoScrollToBottom } from '../../src/web/src/hooks/useAutoScrollToBottom.js'

/**
 * 制造一个可滚 happy-dom 容器: 200px 视口, 内容 1000px 高, scrollHeight
 * 量得到。先 scrollTop=0, 之后可以用 jsdom.scrollTo 调。
 */
function makeScrollableContainer() {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true })
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
  el.scrollTop = 0
  // happy-dom: scrollTo 是 noop, 自己换成直接赋值
  ;(el as HTMLDivElement & { scrollTo: (o: { top: number }) => void }).scrollTo = function ({
    top,
  }: {
    top: number
  }) {
    this.scrollTop = top
  }
  document.body.appendChild(el)
  return el
}

describe('useAutoScrollToBottom', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('初始化时调用 scrollToBottom → 即使距离底部 200px 也跟随 (prevLength=-1 强制)', () => {
    const containerRef = createRef<HTMLDivElement>()
    const el = makeScrollableContainer()
    containerRef.current = el

    const { result } = renderHook(() => useAutoScrollToBottom(containerRef))

    act(() => {
      result.current.scrollToBottom()
    })

    expect(el.scrollTop).toBe(1000)
  })

  it('messages length 不变 (delta) → 不滚', () => {
    const containerRef = createRef<HTMLDivElement>()
    const el = makeScrollableContainer()
    containerRef.current = el

    const { result } = renderHook(() => useAutoScrollToBottom(containerRef))

    // 第一次: 初始化, 应该滚到底
    act(() => result.current.scrollToBottom(0))
    expect(el.scrollTop).toBe(1000)
    el.scrollTop = 100 // 用户主动上滚

    // 模拟 nextLength === prevLength (streaming delta 没新增条目)
    act(() => result.current.scrollToBottom(1))
    expect(el.scrollTop).toBe(100) // 没动
  })

  it('messages length 增长, 用户已在底部 → 滚到底', () => {
    const containerRef = createRef<HTMLDivElement>()
    const el = makeScrollableContainer()
    containerRef.current = el

    const { result } = renderHook(() => useAutoScrollToBottom(containerRef))

    act(() => result.current.scrollToBottom(0)) // init
    el.scrollTop = 990 // 用户停在底部 (10px 距离)

    act(() => result.current.scrollToBottom(1))
    expect(el.scrollTop).toBe(1000)
  })

  it('messages length 增长, 用户已上滚 (> 80px) → 不滚', () => {
    const containerRef = createRef<HTMLDivElement>()
    const el = makeScrollableContainer()
    containerRef.current = el

    const { result } = renderHook(() => useAutoScrollToBottom(containerRef))

    act(() => result.current.scrollToBottom(0)) // init
    el.scrollTop = 100 // 用户上滚 700px 离开底部

    act(() => result.current.scrollToBottom(2)) // 新增 2 条
    expect(el.scrollTop).toBe(100) // 没动, 让用户继续读
  })

  it('container 未挂载 → noop (不抛错)', () => {
    const containerRef = createRef<HTMLDivElement>() // current = null

    const { result } = renderHook(() => useAutoScrollToBottom(containerRef))

    expect(() => {
      act(() => result.current.scrollToBottom(5))
    }).not.toThrow()
  })
})
