import type { V2TaskItem } from '../store/useAgentStore.js'

type Props = { tasks: V2TaskItem[] }

// 样式与 zai-web 现有暗色主题靠齐. padding / 字号 / 行高按 zai-web 现有
// MessageBubble 的视觉密度取近似值, 不引入新 design tokens.
// 边框由原硬编码 #2a2a2a (亮色主题下突兀) 改为 var(--border-subtle):
// 暗色主题解析为 rgba(249,115,22,.18) 主题橙细线, 亮色主题解析为
// LIGHT_PAGE_VARS 注入的 #e5e9f0 中性浅灰, 两个主题都不冲突(2026-09-02
// 用户反馈).
const styles: Record<string, React.CSSProperties> = {
  wrap: {
    margin: '8px 0',
    padding: '8px 12px',
    borderRadius: 6,
    background: 'var(--bg-popup)',
    color: 'var(--text-dim-65)',
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    border: '1px solid var(--border-subtle)',
  },
  header: { marginBottom: 6, color: 'var(--text-dim-45)' },
  list: { listStyle: 'none', padding: 0, margin: 0 },
  item: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' },
  icon: { width: 14, display: 'inline-block', textAlign: 'center' },
  content: { flex: 1 },
}

function statusIcon(status: V2TaskItem['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '■'
  return '☐'
}

// 显示所有非 deleted 任务: pending / in_progress / completed 三个 bucket
// 全终态(completed)是"done", 进行中(in_progress)是"in progress",
// 其余未开始(pending)是"open". V2 'deleted' 是软删除态, 不在 TodoZone
// 渲染, 详情见 TodoDropdown (popover 里带删除线).
export default function TodoZone({ tasks }: Props) {
  const visible = tasks.filter((t) => t.status !== 'deleted')
  if (visible.length === 0) return null
  const done = visible.filter((t) => t.status === 'completed').length
  const inProgress = visible.filter((t) => t.status === 'in_progress').length
  const open = visible.length - done - inProgress
  return (
    <div style={styles.wrap} data-testid="todo-zone">
      <div style={styles.header}>
        {visible.length} tasks ({done} done, {inProgress} in progress, {open} open)
      </div>
      <ul style={styles.list}>
        {visible.map((t, i) => (
          <li
            key={t.id ?? i}
            style={styles.item}
            data-testid={`task-item-${t.status}`}
          >
            <span style={styles.icon}>{statusIcon(t.status)}</span>
            <span style={styles.content}>{t.subject}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
