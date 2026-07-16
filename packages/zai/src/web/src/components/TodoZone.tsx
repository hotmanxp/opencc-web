import type { TodoItem } from '../store/useAgentStore.js'

type Props = { todos: TodoItem[] }

// 样式与 zai-web 现有暗色主题靠齐. padding / 字号 / 行高按 zai-web 现有
// MessageBubble 的视觉密度取近似值, 不引入新 design tokens.
const styles: Record<string, React.CSSProperties> = {
  wrap: {
    margin: '8px 0',
    padding: '8px 12px',
    borderRadius: 6,
    background: '#1a1a1a',
    color: '#d0d0d0',
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    border: '1px solid #2a2a2a',
  },
  header: { marginBottom: 6, color: '#999' },
  list: { listStyle: 'none', padding: 0, margin: 0 },
  item: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' },
  icon: { width: 14, display: 'inline-block', textAlign: 'center' },
  content: { flex: 1 },
}

function statusIcon(status: TodoItem['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '■'
  return '☐'
}

export default function TodoZone({ todos }: Props) {
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.filter((t) => t.status === 'in_progress').length
  const open = todos.length - done - inProgress
  return (
    <div style={styles.wrap} data-testid="todo-zone">
      <div style={styles.header}>
        {todos.length} tasks ({done} done, {inProgress} in progress, {open} open)
      </div>
      <ul style={styles.list}>
        {todos.map((t, i) => (
          <li
            key={i}
            style={styles.item}
            data-testid={`todo-item-${t.status}`}
          >
            <span style={styles.icon}>{statusIcon(t.status)}</span>
            <span style={styles.content}>{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
