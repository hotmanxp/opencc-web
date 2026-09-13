import type { V2TaskItem } from '../store/useAgentStore.js'

type Props = { v2Tasks: V2TaskItem[] }

// 样式与 zai-web 现有暗色主题靠齐. 颜色 / 字号复用 TodoZone 的视觉密度,
// 仅追加 Popover 包裹所需的宽度 / maxHeight / 滚动 / 分割线.

function v2Icon(status: V2TaskItem['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '■'
  if (status === 'deleted') return '✗'
  return '☐'
}

function v2Color(status: V2TaskItem['status']): string {
  if (status === 'completed') return '#52c41a'
  if (status === 'in_progress') return '#a78bfa'
  if (status === 'deleted') return '#f5222d'
  return 'var(--text-dim-40)'
}

const wrapClass =
  'w-[min(360px,calc(100vw-84px))] bg-[var(--bg-popup)] rounded-md p-[10px] ' +
  'max-h-[360px] overflow-y-auto text-white text-xs ' +
  'font-[ui-monospace,SFMono-Regular,Menlo,monospace]'

export default function TodoDropdown({ v2Tasks }: Props) {
  const v2Done = v2Tasks.filter((t) => t.status === 'completed').length
  const v2InProgress = v2Tasks.filter((t) => t.status === 'in_progress').length
  const isEmpty = v2Tasks.length === 0

  if (isEmpty) {
    return (
      <div className={wrapClass} data-testid="todo-dropdown-empty">
        <div className="text-xs text-[var(--text-dim-40)] py-4 px-2 text-center">
          暂无任务
        </div>
      </div>
    )
  }

  return (
    <div className={wrapClass} data-testid="todo-dropdown">
      <div className="text-[11px] font-semibold text-[var(--text-dim-55)] mb-2 flex justify-between">
        <span>任务清单</span>
        <span>
          {v2Done}/{v2Tasks.length} 完成 · {v2InProgress} 进行中
        </span>
      </div>
      <ul className="list-none p-0 m-0">
        {v2Tasks.map((t) => (
          <li
            key={t.id}
            className="flex items-center gap-2 py-[5px] px-[6px] rounded"
            data-testid={`v2-task-dropdown-item-${t.status}`}
          >
            <span className="w-4 text-center text-xs" style={{ color: v2Color(t.status) }}>
              {v2Icon(t.status)}
            </span>
            <span
              className="flex-1"
              style={{
                color:
                  t.status === 'completed' || t.status === 'deleted'
                    ? 'var(--text-dim-45)'
                    : 'var(--text-dim-85)',
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
              <span className="text-[10px] text-[var(--text-dim-45)]">
                依赖 {t.blockedBy.length}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}