import { Tag } from 'antd'
import type { TaskSummary } from '../../lib/superTaskApi'
import { STATUS_TAG, PRIORITY_TAG, STATUS_ACCENT } from './SuperTaskCard'

/**
 * 移动端任务工厂单卡(2026-09-04 新增,/m-super-tasks 路由使用)。
 *
 * 与桌面 SuperTaskCard 的差异:
 *  - **不复用** SuperTaskCard(操作按钮 / 火柴人 / Checkbox / 多行描述
 *    在 375–430px 宽度下全部不可用或视觉过重)。
 *  - 只渲染:左侧状态色条(STATUS_ACCENT) + 优先级 Tag + 状态 Tag +
 *    单行 ellipsis 标题 + 右对齐相对时间。整卡可点 → 打开详情抽屉。
 *  - 三张配色/文案表(STATUS_TAG / PRIORITY_TAG / STATUS_ACCENT)从
 *    SuperTaskCard export 复用 —— 任何改色 / 改文案只改一处。
 *
 * 触控目标 ≥44px(minHeight:56)。
 */
export default function MobileSuperTaskCard({
  task,
  onOpen,
}: {
  task: TaskSummary
  onOpen: (id: string) => void
}): JSX.Element {
  const accent = STATUS_ACCENT[task.status] ?? '#94a3b8'
  const statusTag = STATUS_TAG[task.status] ?? { color: 'default', label: task.status }
  const priorityTag = task.priority
    ? PRIORITY_TAG[task.priority] ?? { color: 'default', label: task.priority }
    : null
  // TaskSummary 上没有 updatedAt 字段 —— 时间戳取 createdAt(最常用,
  // 也是桌面卡片 SuperTaskCard L300-302 用的字段);createdAt 缺失
  // 退到 startedAt / completedAt。完全没有 → 显示「-」。
  const ts = task.createdAt ?? task.startedAt ?? task.completedAt ?? null

  return (
    <div
      data-testid={`mobile-task-card-${task.id}`}
      onClick={() => onOpen(task.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(task.id)
        }
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        borderRadius: 10,
        background: '#ffffff',
        border: '1px solid #e5e9f0',
        borderLeft: `4px solid ${accent}`,
        boxShadow: '0 1px 3px rgba(15,23,42,.06)',
        cursor: 'pointer',
        minHeight: 56,
        outline: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Tag
          color={statusTag.color}
          style={{ marginInlineEnd: 0, fontSize: 12, lineHeight: '18px' }}
          data-testid={`mobile-status-tag-${task.id}`}
        >
          {statusTag.label}
        </Tag>
        {priorityTag && (
          <Tag
            color={priorityTag.color}
            style={{ marginInlineEnd: 0, fontSize: 12, lineHeight: '18px' }}
            data-priority={task.priority}
            data-testid={`mobile-priority-tag-${task.id}`}
          >
            {task.priority}
          </Tag>
        )}
      </div>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.4,
          fontWeight: 500,
          color: '#0f172a',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={task.title}
      >
        {task.title}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          fontSize: 12,
          color: '#94a3b8',
        }}
      >
        {formatRelative(ts)}
      </div>
    </div>
  )
}

/** 相对时间。ts 缺省或不可解析 → 「-」。本组件私有,不 export。 */
function formatRelative(ts: string | number | null | undefined): string {
  if (ts == null) return '-'
  const t = typeof ts === 'number' ? ts : Date.parse(ts)
  if (Number.isNaN(t)) return '-'
  const diffMs = Date.now() - t
  if (diffMs < 0) return '-'
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  return `${day}天前`
}