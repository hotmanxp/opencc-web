import type { TodoItem, V2TaskItem } from '../store/useAgentStore.js'

type Props = { todos: TodoItem[]; v2Tasks: V2TaskItem[] }

// 样式与 zai-web 现有暗色主题靠齐. 颜色 / 字号复用 TodoZone 的视觉密度,
// 仅追加 Popover 包裹所需的宽度 / maxHeight / 滚动 / 分割线.
const styles: Record<string, React.CSSProperties> = {
  wrap: {
    width: 360,
    background: '#1f1f1f',
    borderRadius: 6,
    padding: 10,
    maxHeight: 360,
    overflowY: 'auto',
    color: '#fff',
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  header: {
    fontSize: 11,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.55)',
    marginBottom: 8,
    display: 'flex',
    justifyContent: 'space-between',
  },
  list: { listStyle: 'none', padding: 0, margin: 0 },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 6px',
    borderRadius: 4,
  },
  icon: { width: 16, textAlign: 'center', fontSize: 12 },
  empty: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.40)',
    padding: '16px 8px',
    textAlign: 'center',
  },
  divider: {
    height: 1,
    background: 'rgba(255,255,255,0.08)',
    margin: '10px -10px',
  },
}

function todoIcon(status: TodoItem['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '■'
  return '☐'
}

function v2Icon(status: V2TaskItem['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '■'
  if (status === 'deleted') return '✗'
  return '☐'
}

function todoColor(status: TodoItem['status']): string {
  if (status === 'completed') return '#52c41a'
  if (status === 'in_progress') return '#a78bfa'
  return 'rgba(255,255,255,0.40)'
}

function v2Color(status: V2TaskItem['status']): string {
  if (status === 'completed') return '#52c41a'
  if (status === 'in_progress') return '#a78bfa'
  if (status === 'deleted') return '#f5222d'
  return 'rgba(255,255,255,0.40)'
}

export default function TodoDropdown({ todos, v2Tasks }: Props) {
  const todoDone = todos.filter((t) => t.status === 'completed').length
  const todoInProgress = todos.filter((t) => t.status === 'in_progress').length
  const v2Done = v2Tasks.filter((t) => t.status === 'completed').length
  const v2InProgress = v2Tasks.filter((t) => t.status === 'in_progress').length
  const isEmpty = todos.length === 0 && v2Tasks.length === 0

  if (isEmpty) {
    return (
      <div style={styles.wrap} data-testid="todo-dropdown-empty">
        <div style={styles.empty}>暂无任务或 TODO</div>
      </div>
    )
  }

  return (
    <div style={styles.wrap} data-testid="todo-dropdown">
      {todos.length > 0 && (
        <>
          <div style={styles.header}>
            <span>当前会话 TODO</span>
            <span>
              {todoDone}/{todos.length} 完成 · {todoInProgress} 进行中
            </span>
          </div>
          <ul style={styles.list}>
            {todos.map((t, i) => (
              <li
                key={`todo-${i}`}
                style={styles.item}
                data-testid={`todo-dropdown-item-${t.status}`}
              >
                <span style={{ ...styles.icon, color: todoColor(t.status) }}>
                  {todoIcon(t.status)}
                </span>
                <span
                  style={{
                    flex: 1,
                    color:
                      t.status === 'completed'
                        ? 'rgba(255,255,255,0.45)'
                        : 'rgba(255,255,255,0.85)',
                    textDecoration:
                      t.status === 'completed' ? 'line-through' : 'none',
                  }}
                >
                  {t.content}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {v2Tasks.length > 0 && (
        <>
          <div style={styles.divider} />
          <div style={styles.header}>
            <span>V2 任务清单</span>
            <span>
              {v2Done}/{v2Tasks.length} 完成 · {v2InProgress} 进行中
            </span>
          </div>
          <ul style={styles.list}>
            {v2Tasks.map((t) => (
              <li
                key={t.id}
                style={styles.item}
                data-testid={`v2-task-dropdown-item-${t.status}`}
              >
                <span style={{ ...styles.icon, color: v2Color(t.status) }}>
                  {v2Icon(t.status)}
                </span>
                <span
                  style={{
                    flex: 1,
                    color:
                      t.status === 'completed' || t.status === 'deleted'
                        ? 'rgba(255,255,255,0.45)'
                        : 'rgba(255,255,255,0.85)',
                    textDecoration:
                      t.status === 'completed' || t.status === 'deleted'
                        ? 'line-through'
                        : 'none',
                  }}
                  title={t.description ?? t.subject}
                >
                  {t.subject}
                </span>
                {t.blockedBy.length > 0 && (
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>
                    依赖 {t.blockedBy.length}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}