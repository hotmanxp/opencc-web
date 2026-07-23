// packages/zai/src/web/src/hooks/useAutoScrollToBottom.ts
//
// 把"messages / pendingAsk 更新时是否滚动到底部"封装到 hook 里, 不让 Agent.tsx
// 的 effect 直接调 scrollIntoView。 这样 effect 只关心"messages 变了", 真正的
// 决策 (length 是否增长 / scrollHeight 是否长高 / 用户是否上滚 / 是否用户主动锁)
// 由 hook 内部决定。
//
// 四层防御:
//   1. decideAutoScroll 决策 (autoScroll.ts) — 纯函数, 9 个单测覆盖
//   2. useScrollFollow 锁 — 用户主动滚过 5s 内不打扰 (hooks/useScrollFollow.ts)
//   3. distanceToBottomPx > 80px 视为用户在看历史, 即便 length 增长也不拉回
//   4. contentGrew 信号 — streaming delta 时 length 不变但容器长高, 也要 follow
//
// 决策结果 'follow' 才执行 scrollTo, 默认 'stay' — 这一点跟旧实现相反, 是修复核心。
import { useCallback, useRef, type RefObject } from 'react'
import { useScrollFollow } from './useScrollFollow.js'
import { decideAutoScroll, NEAR_BOTTOM_PX } from './autoScroll.js'

export interface UseAutoScrollToBottomResult {
  /**
   * 调用方放到 useEffect 里, 依赖 [messages, pendingAsk]。
   *
   * @param nextLength 当前 messages.length。第一次调用传 0 (内部用 prevLengthRef
   *                    触发 -1 的初始化路径, 让首屏落到底)。
   */
  scrollToBottom: (nextLength?: number) => void
  /** 容器滚动锁 (用户 5s 内主动滚过), 透传给外部 UI 显示 "N 条新消息" 提示。 */
  scrollLocked: boolean
}

export function useAutoScrollToBottom(
  containerRef: RefObject<HTMLElement | null>,
): UseAutoScrollToBottomResult {
  const prevLengthRef = useRef<number>(-1)
  // 追踪上一次 effect 时的 scrollHeight, 用 "容器内容是否真长高" 作为
  // streaming 期间 "用户需要看新内容" 的关键信号 — 比 nextLength 更准:
  // streaming delta 时 length 不变但 scrollHeight 一直在涨。
  const prevScrollHeightRef = useRef<number>(0)
  const scrollLocked = useScrollFollow(containerRef)

  const scrollToBottom = useCallback(
    (nextLength: number = 0) => {
      const el = containerRef.current
      if (!el) return

      // 量"当前距离底部多远" — 用 scrollHeight - scrollTop - clientHeight。
      // happy-dom / jsdom 的 clientHeight / scrollHeight 在测试里要 Object.defineProperty,
      // 真浏览器里直接读。Floor 到 0, 避免负的小数 (iOS rubber-band 会让 scrollTop
      // 暂时超过 scrollHeight)。
      const distanceToBottomPx = Math.max(
        0,
        el.scrollHeight - el.scrollTop - el.clientHeight,
      )

      // contentGrew = 容器长高. 与 prevLength === nextLength 互补:
      //   - length 增长 (新增 bubble) → contentGrew 通常也是 true
      //   - length 不变但 streaming append 同一 bubble → contentGrew=true, length 信号漏掉
      // 用 delta 而非绝对值, 避免 resize 字体/窗口时的 false positive。
      const contentGrew = el.scrollHeight > prevScrollHeightRef.current

      const decision = decideAutoScroll({
        prevLength: prevLengthRef.current,
        nextLength,
        contentGrew,
        scrollFollowLocked: scrollLocked,
        distanceToBottomPx,
      })

      // DEBUG: log scroll decision
      console.debug('[autoScroll]', {
        prevLength: prevLengthRef.current,
        nextLength,
        contentGrew,
        scrollLocked,
        distanceToBottomPx,
        decision,
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        now: Date.now(),
      })

      if (decision === 'follow') {
        // 用 scrollTo({ top: scrollHeight }) 取代 scrollIntoView: 后者会同时改
        // 整页面 scroll (block:'end' 在嵌套滚动容器里有副作用), 且会触发
        // scroll 事件 (虽然 useScrollFollow 不监听, 但保持局部性更稳)。
        // 平滑滚动交给浏览器原生处理, 不传 behavior: smooth 让浏览器默认即可
        // (浏览器会基于 prefers-reduced-motion 自动选 instant)。
        el.scrollTo({ top: el.scrollHeight })
      }

      // 不管 'follow' 还是 'stay' 都更新 prev, 让 delta 这条同样走 length===prev
      // 路径直接早退 (避免 init 之后 prev 永远 -1)。scrollHeight 也同步,
      // 否则下次 effect 会把"我们刚刚 scrollTo 完留下的新高度"误算成 contentGrew,
      // 触发无谓重滚。
      prevLengthRef.current = nextLength
      prevScrollHeightRef.current = el.scrollHeight
    },
    [containerRef, scrollLocked],
  )

  // 容器尺寸变化时, 如果用户在底部, 重新校正滚动条 (图片加载 / CodeBlock 渲染
  // 完成后视口底部可能突然变了)。用 ResizeObserver 监听 scrollHeight 突变
  // 比较麻烦, 这里只挂 hook 级的 mount/unmount 清 ref。
  // (留待用户报告 "图片加载后被遮住" 时再加 — 现版本不会触发, 决策足够。)

  return { scrollToBottom, scrollLocked }
}

// 透传给调用方让 useEffect 决定距离底部多远算"用户在底部"。
export { NEAR_BOTTOM_PX }