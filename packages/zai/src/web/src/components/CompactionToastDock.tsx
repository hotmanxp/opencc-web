import { useEffect } from 'react'
import { useAgentStore } from '../store/useAgentStore'

/**
 * 压缩提示条 —— 渲染 `useAgentStore.toasts`(CompactionToast)。
 *
 * 为什么挂在 App 而不是 AgentConversation:
 * SSE 事件只 dispatch 到 **根** `useAgentStore` 单例
 * (store/useEventStream.ts:260 `applyBatchTo(useAgentStore, ...)`),而
 * AgentConversation 被 NewSuperTaskModal / QuickCreateModal /
 * MobileSupervisorDrawer 以**各自的 AgentStoreContext** 复用。挂在那里会
 * 在弹窗里读到错误的 store(弹窗内没有 toast),且与 reducer "不做 sessionId
 * 过滤"的意图冲突(toast 是会话级提示,切会话后迟到的事件仍应被看到)。
 *
 * 回收时机:reducer 刻意**不**起定时器(见 useAgentStore.ts applyCompactionEvent
 * 上方注释 —— 避免在 React 渲染路径之外异步写状态),只写 `expiresAt`。所以
 * 这里按**最早**的 expiresAt 设单个 setTimeout,到点后重跑 effect 自然地
 * 把过期项清掉;不做 per-toast timer —— 那样 N 条 toast 就是 N 个定时器,
 * 且手动 dismiss 后会留下孤儿定时器。
 */
export default function CompactionToastDock() {
  const toasts = useAgentStore((s) => s.toasts)
  const dismissCompactionToast = useAgentStore((s) => s.dismissCompactionToast)

  // 最早到期的那条决定下一次唤醒的时间。没有 toast 时 expiresAt 恒为 0,
  // diff 为 0 → clearTimeout + 不排新定时器,自然停摆。
  const nextExpiry = toasts.length
    ? Math.min(...toasts.map((t) => t.expiresAt))
    : 0

  useEffect(() => {
    if (!nextExpiry) return
    const delay = Math.max(0, nextExpiry - Date.now())
    const timer = setTimeout(() => {
      // 到点后把已过期的 dismiss 掉。reducer 存了 id,这里逐条比对
      // expiresAt —— 早于当前时刻的一律回收,晚于的留到下一个周期。
      const now = Date.now()
      for (const t of useAgentStore.getState().toasts) {
        if (t.expiresAt <= now) dismissCompactionToast(t.id)
      }
    }, delay)
    return () => clearTimeout(timer)
  }, [nextExpiry, dismissCompactionToast])

  if (!toasts.length) return null

  return (
    <div
      // 容器不吃指针事件,只有具体每条可点关闭 —— 否则这层会挡住顶部
      // 布局区的交互(状态栏 / 模型选择器常在顶部)。
      className="pointer-events-none fixed left-1/2 top-4 z-50 flex -translate-x-1/2 flex-col items-center gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-2 rounded-lg border border-[var(--border-primary,#e2e8f0)] bg-[var(--bg-elevated,#1c1c26)] px-3 py-2 text-xs text-[var(--text-primary,#1f2937)] shadow-lg"
        >
          <span className="whitespace-nowrap">{t.text}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => dismissCompactionToast(t.id)}
            className="cursor-pointer rounded px-1 text-[var(--text-secondary,#64748b)] transition-colors hover:text-[var(--text-primary,#1f2937)]"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
