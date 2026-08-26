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
   * @param opts.folded 折叠视图态 (transcriptCollapsed === true). 折叠态
   *                    下 outer scrollHeight 受 clamp 干扰, 用 messages
   *                    数组引用变化作为 fallback 信号.
   * @param opts.messagesRef 本次 messages 数组引用. 与 ref 缓存的 prev
   *                    对比, 引用换过即 store 真的写过新数据.
   */
  scrollToBottom: (
    nextLength?: number,
    opts?: { folded?: boolean; messagesRef?: unknown },
  ) => void
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
  // 追踪上一次 effect 时的 scrollTop (post-scrollTo). 用于判定 "user 上一帧
  // 在底部而本帧仍停在原 scrollTop" — 当两次 effect 之间 scrollHeight 涨超
  // 80px 时, scrollTo({top:scrollHeight}) 被浏览器 clamp 限到 scrollHeight -
  // clientHeight, 但 React 后续 render 让 scrollHeight 又涨, 此刻 scrollTop
  // 仍停在旧 max 处, distanceToBottomPx 看起来 > 80 误判 userScrolledAway.
  // 配合 contentGrew 用, 让 hook 知道 "user 没动过 + 内容在脚下, 跟".
  const prevScrollTopRef = useRef<number | null>(null)
  // 追踪上一次 effect 时的 messages 引用, 折叠视图 fallback 路径用:
  // streaming delta / tool_result 都是 in-place 更新 (引用换但 length 不变),
  // 引用变化是 "store 真的写过" 的可靠信号.
  const prevMessagesRef = useRef<unknown>(undefined)
  const scrollLocked = useScrollFollow(containerRef)

  const scrollToBottom = useCallback(
    (
      nextLength: number = 0,
      opts?: { folded?: boolean; messagesRef?: unknown },
    ) => {
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

      // wasAtBottom: 上一帧 scrollTop 与本帧几乎一致 (5px 容差, 过滤滚动条 jitter
      // / iOS rubber-band). 配合 contentGrew 使用, 让 rule #5 在 scrollTop 被 clamp
      // 落后于新 scrollHeight 时仍 follow. 首次 effect prevScrollTopRef === null,
      // 显式排除 (跟 messagesRefChanged 一样的初始化路径处理).
      const wasAtBottom =
        prevScrollTopRef.current !== null &&
        Math.abs(el.scrollTop - prevScrollTopRef.current) < 5

      // 折叠视图 fallback 信号: messages 数组引用换了 (即 store 真的写过),
      // 无论 length 是否增长、scrollHeight 是否增长, 都视为"有新数据要跟".
      // 折叠视图 (maxHeight:140 + overflow:hidden) clamp 让 contentGrew 在文字
      // 越过 ~6 行后停涨, 这条信号是 contentGrew 失真时的救命稻草.
      // 注意: 第一次调用 prevMessagesRef.current === undefined, 不能用
      // !== prevMessagesRef.current 判断. 用 caller 传入的 prev ref 或
      // 用 prevLengthRef === -1 (即初始化路径) 排除.
      const messagesRefChanged =
        prevMessagesRef.current !== undefined &&
        opts?.messagesRef !== undefined &&
        opts.messagesRef !== prevMessagesRef.current

      const { decision, reason } = decideAutoScroll({
        prevLength: prevLengthRef.current,
        nextLength,
        contentGrew,
        scrollFollowLocked: scrollLocked,
        distanceToBottomPx,
        folded: opts?.folded,
        messagesRefChanged,
        wasAtBottom,
      })

      // DEBUG: 每条规则都带 reason, follow / stay 用不同 tag 方便 grep:
      //   [autoScroll-follow]                       → 滚到底
      //   [autoScroll-stay:noChange]                → rule #4: length 没增 + scrollHeight 没涨
      //   [autoScroll-stay:userScrolledAway]        → rule #5: 用户真上滚
      //   [autoScroll-stay:wasAtBottomContentGrew]  → rule #5a follow, 但 tag 也用 stay 一致即可
      //   [autoScroll-stay:scrollFollowLocked]      → rule #1: 用户 5s 锁内
      // 注意: console.debug 保留 .debug 级别, dev console 不需要过滤也能静音.
      const tag = decision === 'follow' ? '[autoScroll-follow]' : `[autoScroll-stay:${reason}]`
      console.debug(tag, {
        prevLength: prevLengthRef.current,
        nextLength,
        contentGrew,
        wasAtBottom,
        scrollLocked,
        distanceToBottomPx,
        folded: opts?.folded,
        messagesRefChanged,
        decision,
        reason,
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
      // 触发无谓重滚。scrollTop 同步让下次 effect 算 wasAtBottom (clamp 落后
      // 补滚这条信号靠的就是 prevScrollTop 与本帧 scrollTop 是否一致)。
      // messagesRef 同步让下次 effect 正确判断引用变化.
      prevLengthRef.current = nextLength
      prevScrollHeightRef.current = el.scrollHeight
      prevScrollTopRef.current = el.scrollTop
      if (opts?.messagesRef !== undefined) {
        prevMessagesRef.current = opts.messagesRef
      }
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