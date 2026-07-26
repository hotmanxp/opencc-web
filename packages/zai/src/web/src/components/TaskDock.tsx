import { useState } from 'react'
import { Badge, Modal, Popover, Tooltip } from 'antd'
import { AppstoreOutlined, CaretRightOutlined, CheckCircleFilled, CloseCircleFilled, CodeOutlined, LoadingOutlined } from '@ant-design/icons'
import { useBackgroundTasks } from '../hooks/useBackgroundTasks.js'
import type { BackgroundTaskSummary } from '../hooks/useBackgroundTasks.js'
import { useBashBackgroundTasks } from '../hooks/useBashBackgroundTasks.js'
import type { BashTaskInfo } from '../lib/taskApi.js'
import { useAppStore } from '../store/useAppStore.js'

const STATUS_ICON: Record<string, JSX.Element> = {
  running: <LoadingOutlined style={{ color: 'var(--accent-start)' }} spin />,
  queued: <CaretRightOutlined style={{ color: 'var(--bg-card-hover)' }} />,
  completed: <CheckCircleFilled style={{ color: 'var(--success)' }} />,
  failed: <CloseCircleFilled style={{ color: 'var(--error)' }} />,
  cancelled: <CloseCircleFilled style={{ color: 'var(--bg-card-hover)' }} />,
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
        color: 'var(--text-primary)',
        fontSize: 12,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent-start)')}
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
              background: 'var(--accent-start)',
              border: '1px solid',
              borderColor: 'var(--accent-start)', // TODO: use borderSubtle CSS var when available
              borderRadius: 3,
              color: 'var(--accent-start)',
              fontWeight: 500,
            }}
          >
            ↻{task.detail.attemptCount - 1}
          </span>
        </Tooltip>
      )}
      <span style={{ color: 'var(--bg-card-hover)', fontSize: 11 }}>{STATUS_LABEL[task.status]}</span>
    </div>
  )
}

const BASH_STATUS_ICON: Record<string, JSX.Element> = {
  running: <CodeOutlined style={{ color: 'var(--accent-start)' }} spin />,
  completed: <CheckCircleFilled style={{ color: 'var(--success)' }} />,
  failed: <CloseCircleFilled style={{ color: 'var(--error)' }} />,
  killed: <CloseCircleFilled style={{ color: 'var(--bg-card-hover)' }} />,
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
        color: 'var(--text-primary)',
        fontSize: 12,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent-start)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ fontSize: 11 }}>{BASH_STATUS_ICON[task.status]}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {truncatePrompt(task.description || task.command)}
      </span>
      <span style={{ color: 'var(--bg-card-hover)', fontSize: 11 }}>
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
 * - isLite=true (右侧分屏展开 或 移动端) 时只显示图标+badge,省掉"后台任务"文本,
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
  // 移动端直接从 useAppStore.isMobile 读, 与 ModelStatusButton 同模式.
  // isLite: 任一紧凑条件 (分屏展开 / 移动端) 命中就只显示图标.
  const isMobile = useAppStore((s) => s.isMobile)
  const isLite = compact || isMobile

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
          // 自适应容器宽度: 桌面 Popover 内 popover 自带 360px 容器足够,
          // 移动 Modal 内 modal 是 90vw, 这里用 100% 跟随. 避免固定 360px
          // 在窄屏 (<400px) 把 modal 撑破.
          width: '100%',
          background: 'var(--bg-card)',
          borderRadius: 6,
          padding: 8,
          maxHeight: 480,
          overflowY: 'auto',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--bg-card-hover)',
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
              color: 'var(--bg-card-hover)',
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
                color: 'var(--accent-start)',
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
                color: 'var(--bg-card-hover)',
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
                color: 'var(--accent-start)',
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
    <>
      <Tooltip
        title={
          total === 0
            ? '暂无后台任务'
            : `${total} 个后台 Agent 运行中,点击查看`
        }
      >
        <span
          onClick={() => {
            // 桌面端走 Popover(触发器控制), 移动端走 Modal(下方单独渲染).
            if (isMobile) setOpen(true)
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            cursor: 'pointer',
            fontSize: 12,
            color: total > 0 ? '#a78bfa' : 'var(--bg-card-hover)', // kept: #a78bfa (purple accent — no CSS var mapping)
          }}
        >
          <Badge count={total} size="small" offset={isLite ? [2, -2] : [4, -2]} color="#a78bfa">
            {isLite ? (
              // isLite (分屏展开 / 移动端) 模式: 只显示图标,省掉"后台任务"文本.
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

      {/* 桌面端 Popover (从触发器左上角展开, 不会越过屏幕右缘) */}
      {!isMobile && (
        <Popover
          content={<div onClick={(e) => e.stopPropagation()}>{content}</div>}
          trigger="click"
          placement="topLeft"
          open={open}
          onOpenChange={setOpen}
          destroyTooltipOnHide
        >
          <span style={{ display: 'none' }} aria-hidden />
        </Popover>
      )}

      {/* 移动端 Modal: 触发按钮在右下, Popover 向左扩展空间不足被截断,
          改用居中 Modal 占 90vw 居中弹窗, 不依赖触发位置. */}
      {isMobile && (
        <Modal
          open={open}
          onCancel={() => setOpen(false)}
          footer={null}
          width="90vw"
          centered
          destroyOnClose
          title="后台任务"
          styles={{
            body: { padding: 0, background: 'var(--bg-card)', borderRadius: 6 },
          }}
        >
          {content}
        </Modal>
      )}
    </>
  )
}