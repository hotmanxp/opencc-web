import { useState } from 'react'
import { Badge, Modal, Popover, Tooltip } from 'antd'
import { AppstoreOutlined, CaretRightOutlined, CheckCircleFilled, CloseCircleFilled, CodeOutlined, LoadingOutlined } from '@ant-design/icons'
import { useBackgroundTasks } from '../hooks/useBackgroundTasks.js'
import type { BackgroundTaskSummary } from '../hooks/useBackgroundTasks.js'
import { useBashBackgroundTasks } from '../hooks/useBashBackgroundTasks.js'
import type { BashTaskInfo } from '../lib/taskApi.js'
import { useAppStore } from '../store/useAppStore.js'

const STATUS_ICON: Record<string, JSX.Element> = {
  running: <LoadingOutlined className="text-[var(--accent-start)]" spin />,
  queued: <CaretRightOutlined className="text-[var(--ui-text-color)]" />,
  completed: <CheckCircleFilled className="text-[var(--success)]" />,
  failed: <CloseCircleFilled className="text-[var(--error)]" />,
  cancelled: <CloseCircleFilled className="text-[var(--ui-text-color)]" />,
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
      className="flex items-center gap-2 py-1.5 px-2.5 cursor-pointer rounded text-[var(--text-primary)] text-xs"
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent-start)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span className="text-[11px]">{STATUS_ICON[task.status]}</span>
      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {truncatePrompt(task.prompt || '(空 prompt)')}
      </span>
      {/* 重试角标: attemptCount > 1 时显示, 让用户在 dock 列表里一眼看到
          "这条任务被自动重试过 N-1 次". 用紫色与失败红色区分. */}
      {task.detail?.attemptCount !== undefined && task.detail.attemptCount > 1 && (
        <Tooltip title={`BackgroundRuntime 自动重试了 ${task.detail.attemptCount - 1} 次`}>
          <span
            className="text-[10px] px-1 bg-[var(--accent-start)] border border-solid border-[var(--accent-start)] rounded-sm text-[var(--accent-start)] font-medium"
          >
            ↻{task.detail.attemptCount - 1}
          </span>
        </Tooltip>
      )}
      <span className="text-[var(--ui-text-color)] text-[11px]">{STATUS_LABEL[task.status]}</span>
    </div>
  )
}

const BASH_STATUS_ICON: Record<string, JSX.Element> = {
  running: <CodeOutlined className="text-[var(--accent-start)]" spin />,
  completed: <CheckCircleFilled className="text-[var(--success)]" />,
  failed: <CloseCircleFilled className="text-[var(--error)]" />,
  killed: <CloseCircleFilled className="text-[var(--ui-text-color)]" />,
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
      className="flex items-center gap-2 py-1.5 px-2.5 cursor-pointer rounded text-[var(--text-primary)] text-xs"
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent-start)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span className="text-[11px]">{BASH_STATUS_ICON[task.status]}</span>
      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {truncatePrompt(task.description || task.command)}
      </span>
      <span className="text-[var(--ui-text-color)] text-[11px]">
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
        className="w-full bg-[var(--bg-card)] rounded-md p-2 max-h-[480px] overflow-y-auto box-border"
      >
        <div
          className="text-[11px] font-semibold text-[var(--ui-text-color)] mb-1.5 px-1 flex justify-between"
        >
          <span>后台任务</span>
          <span>
            {runningTasks.length} Agent / {bashRunning} Bash 运行中 · {recentTasks.length} 最近
          </span>
        </div>

        {runningTasks.length === 0 && recentTasks.length === 0 && bashTasks.length === 0 && (
          <div
            className="text-xs text-[var(--ui-text-color)] py-4 px-2 text-center"
          >
            暂无后台任务
          </div>
        )}

        {runningTasks.length > 0 && (
          <>
            <div
              className="text-[10px] font-semibold text-[var(--accent-start)] uppercase py-1 px-1"
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
              className="text-[10px] font-semibold text-[var(--ui-text-color)] uppercase pt-2 pb-1 px-1"
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
              className="text-[10px] font-semibold text-[var(--accent-start)] uppercase pt-2 pb-1 px-1"
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

  // 触发器样式 (桌面 / 移动共用). Tooltip 包一层用于 hover 提示.
  const trigger = (
    <span
      style={{
        color: total > 0 ? '#a78bfa' : 'var(--ui-text-color)',
      }}
      className="inline-flex items-center gap-1 cursor-pointer text-xs"
    >
      <Badge count={total} size="small" offset={isLite ? [2, -2] : [4, -2]} color="#a78bfa">
        {isLite ? (
          // isLite (分屏展开 / 移动端) 模式: 只显示图标,省掉"后台任务"文本.
          // 视觉与 ModeStatusButton 在 compact 下的精简策略一致.
          <AppstoreOutlined
            className="px-1 text-[14px] leading-none"
            aria-label="后台任务"
          />
        ) : (
          <span className="px-1 text-xs leading-none">后台任务</span>
        )}
      </Badge>
    </span>
  )

  if (isMobile) {
    // 移动端: Modal 由 onClick 显式 setOpen 控制, 跟 Popover 的 trigger click
    // 解耦 (Popover 在窄屏触发位置不够, 改居中弹窗).
    return (
      <>
        <Tooltip
          title={
            total === 0
              ? '暂无后台任务'
              : `${total} 个后台 Agent 运行中,点击查看`
          }
        >
          <span onClick={() => setOpen((o) => !o)}>{trigger}</span>
        </Tooltip>
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
      </>
    )
  }

  // 桌面端: 把可见触发器嵌进 Popover, AntD Trigger 自己管 click 切换.
  // 修复前可见触发器在 Popover 外面, AntD click-outside 把它当外部点击 →
  // 立刻 setOpen(false), 出现"闪一下就消失". 让 Trigger 自己持有触发器
  // ref, 它就不会误判.
  return (
    <Popover
      content={<div onClick={(e) => e.stopPropagation()}>{content}</div>}
      trigger="click"
      placement="topLeft"
    >
      <Tooltip
        title={
          total === 0
            ? '暂无后台任务'
            : `${total} 个后台 Agent 运行中,点击查看`
        }
      >
        {trigger}
      </Tooltip>
    </Popover>
  )
}