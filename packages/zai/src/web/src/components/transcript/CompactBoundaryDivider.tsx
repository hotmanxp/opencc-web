import { useState } from 'react'
import type { AgentMessage } from '../../store/useAgentStore.js'

/**
 * 压缩分界线 —— 渲染一条 `compact_boundary` 消息。
 *
 * 数据来源两条,形态刻意一致(见 loadTranscriptMessages):
 *   - 实时:translator 的 `case "system"` 收到 vendor boundary 后 yield
 *     `compact_boundary` RuntimeEvent(shared/events.ts 里有对应 schema);
 *   - 回放:transcript 里的 `system` + `subtype:'compact_boundary'` 行
 *     (vendor 形状)或遗留的 `type:'compact_boundary'` 行。
 *
 * 摘要正文: auto-compact 的摘要是 user 消息带 isCompactSummary 标记,
 * 直接渲染会变成一个巨大的英文用户气泡(见 useAgentStore
 * loadTranscriptMessages 的守卫),所以正文被 attachSummaryToBoundary 挂到
 * 分界线的 `summary` 字段上,这里默认折叠、按需展开。
 *
 * 手动 /compact 的摘要是一条普通 assistant 消息(不是 isCompactSummary),
 * 仍按正常气泡渲染 —— 那是用户主动要的可读摘要,不该藏起来。
 */
export default function CompactBoundaryDivider({ message }: { message: AgentMessage }) {
  const [open, setOpen] = useState(false)
  const m = message as {
    trigger?: 'auto' | 'manual'
    preTokens?: number
    messagesSummarized?: number
    summary?: string
  }
  const summary = typeof m.summary === 'string' ? m.summary.trim() : ''
  const pre = typeof m.preTokens === 'number' ? m.preTokens : 0
  const label =
    m.trigger === 'manual' ? '对话已压缩 · 手动' : '对话已压缩 · 自动'

  return (
    <div className="my-3" data-testid="compact-boundary">
      {/* 有摘要时整行可点(展开/收起);没有摘要就是纯静态分界线 —— 但仍用
          <button> 保持键盘可达性与一致的 hover 反馈。 */}
      <button
        type="button"
        onClick={() => summary && setOpen((v) => !v)}
        aria-expanded={summary ? open : undefined}
        title={summary ? (open ? '收起摘要' : '展开摘要') : undefined}
        className="flex w-full cursor-pointer items-center gap-3 text-xs text-[var(--text-secondary,#64748b)] transition-colors hover:text-[var(--text-primary,#1f2937)]"
      >
        <span className="h-px flex-1 bg-[var(--border-primary,#e2e8f0)]" />
        <span className="whitespace-nowrap">
          {label}
          {pre > 0 && ` · 上下文 ${pre.toLocaleString()} tokens 已归档`}
          {typeof m.messagesSummarized === 'number' &&
            m.messagesSummarized > 0 &&
            ` · 摘要了 ${m.messagesSummarized} 条消息`}
          {summary && (open ? ' ▲' : ' ▼')}
        </span>
        <span className="h-px flex-1 bg-[var(--border-primary,#e2e8f0)]" />
      </button>
      {open && summary && (
        <div className="mt-2 rounded-lg border border-[var(--border-primary,#e2e8f0)] bg-[var(--bg-card,#ffffff)] p-3 text-xs leading-relaxed text-[var(--text-secondary,#64748b)]">
          <pre className="whitespace-pre-wrap break-words font-sans">
            {summary}
          </pre>
        </div>
      )}
    </div>
  )
}
