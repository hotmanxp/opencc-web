import { Spin } from 'antd'
import { useAgentStore } from '../store/useAgentStore'

/**
 * 压缩过程态指示条 —— 渲染 `useAgentStore.compacting`,压缩期间显示
 * 「正在压缩…」。
 *
 * **刻意不与 CompactionToastDock 合并**(二者并列挂在 App.tsx):
 * toast 池靠每条的 `expiresAt`(timestamp + 5000)自动回收,压缩常耗时
 * 数十秒 —— 塞进同一个池会被 5s 的回收逻辑误删,更糟的是 CompactionToastDock
 * 的回收定时器按**最早**的 expiresAt 排程,一条长寿命条目会把正常 toast 的
 * 回收节奏带偏。各管各的状态,不要合并。
 *
 * 为什么挂 App 而非 AgentConversation:SSE 事件只 dispatch 到**根**
 * `useAgentStore` 单例(store/useEventStream.ts 的 applyBatchTo),而
 * AgentConversation 被 NewSuperTaskModal / QuickCreateModal /
 * MobileSupervisorDrawer 以各自的 AgentStoreContext 复用 —— 挂那里会在弹窗
 * 里读到空 store,指示条不显示。同 CompactionToastDock 的理由。
 *
 * 移动端(/m)是 AppRouter 内的路由(router.tsx:156 渲染 MobileAgent →
 * AgentConversation),挂在 App 层因此**自动继承**,不需要第二份实现。
 *
 * 样式沿用 McpServersSection.tsx:157-160 的 `<Spin size="small" />` +
 * 文案先例;全站无 i18n,中文内联(同 CompactBoundaryDivider.tsx:32)。
 */
export default function CompactingIndicator() {
  const compacting = useAgentStore((s) => s.compacting)

  // 结束态不渲染 —— 不留任何占位,避免压缩前后布局跳动。
  if (!compacting) return null

  return (
    <div
      // pointer-events-none: 指示条是纯提示,不能挡住顶部布局区
      // (状态栏 / 模型选择器常在顶部)的点击。
      className="pointer-events-none fixed left-1/2 top-16 z-50 -translate-x-1/2"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 rounded-lg border border-[var(--border-primary,#e2e8f0)] bg-[var(--bg-elevated,#1c1c26)] px-3 py-2 text-xs text-[var(--text-primary,#1f2937)] shadow-lg">
        <Spin size="small" />
        <span className="whitespace-nowrap">正在压缩…</span>
      </div>
    </div>
  )
}