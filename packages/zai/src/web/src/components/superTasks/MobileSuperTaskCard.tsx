import { useState } from 'react'
import { Button, Popconfirm, Tag, Tooltip, message } from 'antd'
import { CloseOutlined, PlayCircleOutlined } from '@ant-design/icons'
import type { TaskSummary } from '../../lib/superTaskApi'
import { deleteSuperTasks } from '../../lib/superTaskApi'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import { STATUS_TAG, PRIORITY_TAG, STATUS_ACCENT } from './SuperTaskCard'

/**
 * 移动端任务工厂单卡(2026-09-04 新增,/m-super-tasks 路由使用)。
 *
 * 与桌面 SuperTaskCard 的差异:
 *  - **不复用** SuperTaskCard(操作按钮 / 火柴人 / Checkbox / 多行描述
 *    在 375–430px 宽度下全部不可用或视觉过重)。
 *  - 只渲染:左侧状态色条(STATUS_ACCENT) + 优先级 Tag + 状态 Tag +
 *    「轻量」Tag(quick 任务专属,2026-09-04 round 2 补) +
 *    单行 ellipsis 标题 + 右对齐相对时间 + 操作按钮区。整卡可点 → 打开详情抽屉。
 *  - 三张配色/文案表(STATUS_TAG / PRIORITY_TAG / STATUS_ACCENT)从
 *    SuperTaskCard export 复用 —— 任何改色 / 改文案只改一处。
 *
 * 2026-09-04(tf-al38784c)补:右上角紧凑 × 删除按钮 + Popconfirm 二次确认。
 * 仅 queued / done / failed / paused 状态可点;processing / verifying 状态
 * 按钮 disabled + tooltip 解释。点 × 走 `e.stopPropagation()` 阻断卡片 onOpen。
 *
 * 2026-09-05(tf-oi7wu722)补:卡片底部操作区在 `status === 'queued'` 时
 * 显示「启动」按钮(▶ + 文字),调 `useSuperTaskStore.start(id)` →
 * `POST /api/super-tasks/<id>/start`。loading 期间按钮显示 Spin +
 * disabled,避免重复点击。其他状态不显示启动按钮。点击走 stopPropagation
 * 阻断卡片 onOpen。触控目标 minHeight:32 + padding 4px,跟桌面
 * SuperTaskCard L319-327 的 icon-only 启动按钮语义一致,但移动端
 * 加文字便于一眼识别。
 *
 * 触控目标 ≥44px(整卡 minHeight:56;启动按钮独立区)。
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
  // 状态守卫:processing / verifying 桶不可删(in-flight 任务避免打断),
  // 后端对这两个状态也会返 409,前端 disabled 是双保险。
  const deletable = task.status !== 'processing' && task.status !== 'verifying'
  // 仅 queued 任务可手动启动(tf-oi7wu722):与桌面 SuperTaskCard L319
  // 同款 `bucket === 'queue-tasks'` 守卫,这里直接以 status 兜底(避免
  // 历史无 bucket 字段的 legacy 数据漏显示)。
  const canStart = task.status === 'queued'
  // 启动按钮 loading 态:防止用户在 RPC 飞行中重复点击。store.start 内
  // 部 await startSuperTask 再 await load() → 期间按钮 disabled。
  const [starting, setStarting] = useState(false)

  async function handleDelete(): Promise<void> {
    try {
      await deleteSuperTasks([task.id])
      message.success(`任务 ${task.id} 已删除`)
    } catch (err) {
      message.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleStart(): Promise<void> {
    if (starting) return
    setStarting(true)
    try {
      await useSuperTaskStore.getState().start(task.id)
      message.success(`任务 ${task.id} 已启动`)
    } catch (err) {
      message.error(`启动失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setStarting(false)
    }
  }

  const deleteBtn = (
    <Tooltip title={deletable ? '删除该任务' : '处理中任务不可删(避免打断正在执行/验证的工作流)'}>
      <Button
        size="small"
        shape="circle"
        icon={<CloseOutlined />}
        disabled={!deletable}
        aria-label={`删除任务 ${task.title}`}
        data-testid={`mobile-card-delete-${task.id}`}
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', top: 6, right: 6, zIndex: 1 }}
      />
    </Tooltip>
  )

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
        position: 'relative',
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
        {/* zai patch (2026-09-04, quick-intake round 2):quick 任务在状态/优先级 Tag 旁
            渲染「轻量」Tag —— 跟桌面 SuperTaskCard L242-253 同款语义,移动端一眼可辨;
            data-testid 用 `quick-tag-${task.id}` 与桌面 `mode-quick-${task.id}` 同源,
            验收时两类 ID 都能用。 */}
        {task.mode === 'quick' && (
          <Tag
            color="default"
            style={{ marginInlineEnd: 0, fontSize: 12, lineHeight: '18px' }}
            data-mode="quick"
            data-testid={`quick-tag-${task.id}`}
          >
            轻量
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
          paddingRight: 28, // 给右上角 × 按钮留位,避免标题被遮
        }}
        title={task.title}
      >
        {task.title}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 12, color: '#94a3b8' }}>
          {formatRelative(ts)}
        </span>
        {/* zai patch (2026-09-05, tf-oi7wu722):启动按钮 —— 仅 queued 状态显示。
            与桌面 SuperTaskCard L319-327 同款语义(▶ + start(id)),移动端
            加文字「启动」便于一眼识别,触控目标 ≥44px。loading 期间按钮
            disabled,防重复点击。stopPropagation 不触发卡片 onOpen。 */}
        {canStart && (
          <Tooltip title="立即执行该任务">
            <Button
              size="small"
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={starting}
              disabled={starting}
              aria-label={`启动任务 ${task.title}`}
              data-testid={`mobile-card-start-${task.id}`}
              onClick={(e) => { e.stopPropagation(); void handleStart() }}
            >
              启动
            </Button>
          </Tooltip>
        )}
      </div>
      {/* 右上角 × 删除按钮(tf-al38784c):Popconfirm 二次确认,状态守卫见上,
          onClick stopPropagation 不触发卡片 onOpen。 */}
      <Popconfirm
        title="删除该任务?"
        description="删除后任务目录与执行记录会被清理。"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onConfirm={() => { void handleDelete() }}
        onPopupClick={(e) => e.stopPropagation()}
      >
        {deleteBtn}
      </Popconfirm>
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
