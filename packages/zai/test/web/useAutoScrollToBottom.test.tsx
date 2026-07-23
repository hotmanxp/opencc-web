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

  it('messages length + scrollHeight 都没变 → 不滚 (维持用户当前位置)', () => {
    const containerRef = createRef<HTMLDivElement>()
    const el = makeScrollableContainer()
    containerRef.current = el

    const { result } = renderHook(() => useAutoScrollToBottom(containerRef))

    // 第一次: 初始化, 应该滚到底
    act(() => result.current.scrollToBottom(0))
    expect(el.scrollTop).toBe(1000)
    el.scrollTop = 100 // 用户主动上滚

    // 模拟完全无变化的 effect 重跑 (nextLength===prev 且 scrollHeight 未变):
    // 既不滚回底部, 也不动 — 尊重用户位置。
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

  // 回归测试: streaming delta 时 messages.length 不变, 但容器内容长高
  // (e.g. 同一 assistant.text bubble 持续 append). 此前 decideAutoScroll
  // 在 nextLength <= prevLength 路径早退 → 用户停在老位置, 看不到新内容。
  // 新逻辑: 检测 scrollHeight 增长 + 用户在底部, 继续跟随。
  //
  // 关键: prevLengthRef 在 init 后已被设为 1 (上一轮 messages 已经存在), 现在
  // streaming 不断推 delta 但 length 始终 1。必须连续跑两次 delta 才能暴露
  // "prevLength===nextLength 路径" 的 bug — 第一次 delta 走 prev=-1 路径
  // 是 'follow', 看起来正确, 但后续每条 delta 都走 stay 路径。
  it('streaming delta (length 不变, scrollHeight 增长, 用户在底部) → 跟随', () => {
    const containerRef = createRef<HTMLDivElement>()
    const el = makeScrollableContainer()
    containerRef.current = el

    const { result } = renderHook(() => useAutoScrollToBottom(containerRef))

    // 把 prevLengthRef 推到 1, 模拟"已经在对话中, 上一轮已经有 1 条消息"
    act(() => result.current.scrollToBottom(1))
    expect(el.scrollTop).toBe(1000)

    // 第 1 个 delta: scrollHeight 1000 → 1100, length 仍是 1, prevLength=1
    Object.defineProperty(el, 'scrollHeight', { value: 1100, configurable: true })
    el.scrollTop = 900 // 用户跟到底部 (距离 0)
    act(() => result.current.scrollToBottom(1))
    expect(el.scrollTop).toBe(1100)

    // 第 2 个 delta: scrollHeight 1100 → 1200, length 仍是 1 — 这就是旧 bug
    Object.defineProperty(el, 'scrollHeight', { value: 1200, configurable: true })
    el.scrollTop = 1000
    act(() => result.current.scrollToBottom(1))
    expect(el.scrollTop).toBe(1200)
  })

  // 回归测试: streaming delta 期间用户主动上滚 (wheel/键盘) → 锁住, 不拉回。
  // 锁 + length 不增长 + 用户已远离底部 三种信号叠加, 一律 stay。
  it('streaming delta (length 不变, scrollHeight 增长, 但用户已上滚) → 不滚', () => {
    const containerRef = createRef<HTMLDivElement>()
    const el = makeScrollableContainer()
    containerRef.current = el

    const { result } = renderHook(() => useAutoScrollToBottom(containerRef))

    // 初始化
    act(() => result.current.scrollToBottom(0))
    expect(el.scrollTop).toBe(1000)

    // 模拟 streaming delta: scrollHeight 增长
    Object.defineProperty(el, 'scrollHeight', { value: 1300, configurable: true })
    // 用户主动上滚 1000px (看到的是更早的内容)
    el.scrollTop = 100

    // 触发 user-gesture lock: 派 wheel 事件 → useScrollFollow 锁住 5s
    act(() => {
      el.dispatchEvent(new Event('wheel'))
    })

    act(() => result.current.scrollToBottom(1))
    expect(el.scrollTop).toBe(100) // 没动, 尊重用户翻历史
  })
})
