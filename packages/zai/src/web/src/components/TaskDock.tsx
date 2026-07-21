import { useState } from 'react'
import { Badge, Popover, Tooltip } from 'antd'
import { AppstoreOutlined, CaretRightOutlined, CheckCircleFilled, CloseCircleFilled, CodeOutlined, LoadingOutlined } from '@ant-design/icons'
import { useBackgroundTasks } from '../hooks/useBackgroundTasks.js'
import type { BackgroundTaskSummary } from '../hooks/useBackgroundTasks.js'
import { useBashBackgroundTasks } from '../hooks/useBashBackgroundTasks.js'
import type { BashTaskInfo } from '../lib/taskApi.js'

const STATUS_ICON: Record<string, JSX.Element> = {
  running: <LoadingOutlined style={{ color: '#a78bfa' }} spin />,
  queued: <CaretRightOutlined style={{ color: 'rgba(255,255,255,0.55)' }} />,
  completed: <CheckCircleFilled style={{ color: '#52c41a' }} />,
  failed: <CloseCircleFilled style={{ color: '#f5222d' }} />,
  cancelled: <CloseCircleFilled style={{ color: 'rgba(255,255,255,0.40)' }} />,
}

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  queued: '排队中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
}

function truncatePrompt(prompt: string, max = 40): string {
  const cleaned = prompt.replace(/\s+/g, ' ').trim()
  return cleaned.length > max ? cleaned.slice(0, max) + '…' : cleaned
}

function Row({
  task,
  onSelect,
}: {
  task: BackgroundTaskSummary
  onSelect: (id: string) => void
}) {
  return (
    <div
      onClick={() => onSelect(task.taskId)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        cursor: 'pointer',
        borderRadius: 4,
        color: '#fff',
        fontSize: 12,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(168, 139, 250, 0.12)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ fontSize: 11 }}>{STATUS_ICON[task.status]}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {truncatePrompt(task.prompt || '(空 prompt)')}
      </span>
      {/* 重试角标: attemptCount > 1 时显示, 让用户在 dock 列表里一眼看到
          "这条任务被自动重试过 N-1 次". 用紫色与失败红色区分. */}
      {task.detail?.attemptCount !== undefined && task.detail.attemptCount > 1 && (
        <Tooltip title={`BackgroundRuntime 自动重试了 ${task.detail.attemptCount - 1} 次`}>
          <span
            style={{
              fontSize: 10,
              padding: '0 4px',
              background: 'rgba(168, 139, 250, 0.18)',
              border: '1px solid rgba(168, 139, 250, 0.40)',
              borderRadius: 3,
              color: '#a78bfa',
              fontWeight: 500,
            }}
          >
            ↻{task.detail.attemptCount - 1}
          </span>
        </Tooltip>
      )}
      <span style={{ color: 'rgba(255,255,255,0.40)', fontSize: 11 }}>{STATUS_LABEL[task.status]}</span>
    </div>
  )
}

const BASH_STATUS_ICON: Record<string, JSX.Element> = {
  running: <CodeOutlined style={{ color: '#a78bfa' }} spin />,
  completed: <CheckCircleFilled style={{ color: '#52c41a' }} />,
  failed: <CloseCircleFilled style={{ color: '#f5222d' }} />,
  killed: <CloseCircleFilled style={{ color: 'rgba(255,255,255,0.40)' }} />,
}

function BashRow({
  task,
  onSelect,
}: {
  task: BashTaskInfo
  onSelect: (id: string) => void
}) {
  return (
    <div
      onClick={() => onSelect(task.taskId)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        cursor: 'pointer',
        borderRadius: 4,
        color: '#fff',
        fontSize: 12,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(168, 139, 250, 0.12)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ fontSize: 11 }}>{BASH_STATUS_ICON[task.status]}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {truncatePrompt(task.description || task.command)}
      </span>
      <span style={{ color: 'rgba(255,255,255,0.40)', fontSize: 11 }}>
        {STATUS_LABEL[task.status] ?? task.status}
      </span>
    </div>
  )
}

/**
 * 底部状态栏上的后台任务 dock。
 * - 当 running > 0 时显示徽章数字
 * - 点击展开 Popover,列出活跃 + 最近结束的任务
 * - 点击某行 → 通过 onSelect 通知外部打开 Drawer
 * - compact=true(右侧分屏展开)时只显示图标+badge,省掉"后台任务"文本,
 *   跟 ModeStatusButton 在 compact 下的精简策略一致.
 */
export function TaskDock({
  onSelect,
  compact = false,
}: {
  onSelect: (id: string) => void
  compact?: boolean
}) {
  const { runningTasks, recentTasks } = useBackgroundTasks()
  const { tasks: bashTasks } = useBashBackgroundTasks()
  const [open, setOpen] = useState(false)

  const bashRunning = bashTasks.filter((t) => t.status === 'running').length
  const total = runningTasks.length + bashRunning

  // 空态时直接 return null — 所有 hooks 已在上面调用, 顺序在每次渲染中固定,
  // 不会触发 React #310 (Rules of Hooks 要求: hooks 必须在每次渲染中按相同
  // 顺序调用相同数量, 不能在条件分支里跳过).
  if (total === 0 && recentTasks.length === 0 && bashTasks.length === 0) {
    return null
  }

  const content = (
      <div
        style={{
          width: 360,
          background: '#1f1f1f',
          borderRadius: 6,
          padding: 8,
          maxHeight: 480,
          overflowY: 'auto',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.55)',
            marginBottom: 6,
            padding: '0 4px',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>后台任务</span>
          <span>
            {runningTasks.length} Agent / {bashRunning} Bash 运行中 · {recentTasks.length} 最近
          </span>
        </div>

        {runningTasks.length === 0 && recentTasks.length === 0 && bashTasks.length === 0 && (
          <div
            style={{
              fontSize: 12,
              color: 'rgba(255,255,255,0.40)',
              padding: '16px 8px',
              textAlign: 'center',
            }}
          >
            暂无后台任务
          </div>
        )}

        {runningTasks.length > 0 && (
          <>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: '#a78bfa',
                textTransform: 'uppercase',
                padding: '4px 4px',
              }}
            >
              运行中
            </div>
            {runningTasks.map((t) => (
              <Row
                key={t.taskId}
                task={t}
                onSelect={(id) => {
                  onSelect(id)
                  setOpen(false)
                }}
              />
            ))}
          </>
        )}

        {recentTasks.length > 0 && (
          <>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.45)',
                textTransform: 'uppercase',
                padding: '8px 4px 4px',
              }}
            >
              最近
            </div>
            {recentTasks.slice(0, 8).map((t) => (
              <Row
                key={t.taskId}
                task={t}
                onSelect={(id) => {
                  onSelect(id)
                  setOpen(false)
                }}
              />
            ))}
          </>
        )}

        {bashTasks.length > 0 && (
          <>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: '#a78bfa',
                textTransform: 'uppercase',
                padding: '8px 4px 4px',
              }}
            >
              Bash {bashRunning} 运行中 / {bashTasks.length - bashRunning} 结束
            </div>
            {bashTasks.slice(0, 8).map((t) => (
              <BashRow
                key={t.taskId}
                task={t}
                onSelect={(id) => {
                  onSelect(id)
                  setOpen(false)
                }}
              />
            ))}
          </>
        )}
      </div>
  );

  return (
    <Popover
      content={<div onClick={(e) => e.stopPropagation()}>{content}</div>}
      trigger="click"
      placement="topLeft"
      open={open}
      onOpenChange={setOpen}
      destroyTooltipOnHide
    >
      <Tooltip
        title={
          total === 0
            ? '暂无后台任务'
            : `${total} 个后台 Agent 运行中,点击查看`
        }
      >
        <span
          onClick={(e) => {
            if (total === 0 && recentTasks.length === 0) {
              e.preventDefault()
              e.stopPropagation()
            }
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            cursor: 'pointer',
            fontSize: 12,
            color: total > 0 ? '#a78bfa' : 'rgba(255,255,255,0.40)',
          }}
        >
          <Badge count={total} size="small" offset={compact ? [2, -2] : [4, -2]} color="#a78bfa">
            {compact ? (
              // compact(右侧分屏展开)模式: 只显示图标,省掉"后台任务"文本.
              // 视觉与 ModeStatusButton 在 compact 下的精简策略一致.
              <AppstoreOutlined
                style={{ padding: '0 4px', fontSize: 14, lineHeight: 1 }}
                aria-label="后台任务"
              />
            ) : (
              <span style={{ padding: '0 4px', fontSize: 12, lineHeight: 1 }}>后台任务</span>
            )}
          </Badge>
        </span>
      </Tooltip>
    </Popover>
  )
}