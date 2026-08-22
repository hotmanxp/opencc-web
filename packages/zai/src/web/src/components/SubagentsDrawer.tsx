/**
 * dsh-019: dsh-mode subagent 任务列表 Drawer。
 *
 * 简化版(Phase 1):打开后展示当前 session 的 subagent 任务,每行带
 * 状态图标 + 描述 + interrupt 按钮(运行中的任务)。
 *
 * 不进 main chat input area — 在 TaskDock 顶部加个 "Subagents" 按钮
 * 触发打开,数据源 useSubagentTasks hook(5s 轮询)。
 *
 * Phase 2 改进:换 SSE 推送 + 加 send_message input 投递指令到子 agent
 * (对齐 dsh-bridge.sendMessageToDshSubagent) + TaskDrawer 一样的详情
 * 面板(event stream / tool calls 展开)。
 */

import { Drawer, Empty, Tag, Tooltip, Button, Space } from 'antd'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  StopOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { useSubagentTasks, interruptSubagentTask, type DshSubagentTask } from '../hooks/useSubagentTasks.js'

const STATUS_ICON: Record<string, JSX.Element> = {
  running: <LoadingOutlined style={{ color: 'var(--accent-start)' }} spin />,
  done: <CheckCircleFilled style={{ color: 'var(--success)' }} />,
  failed: <CloseCircleFilled style={{ color: 'var(--error)' }} />,
  cancelled: <CloseCircleFilled style={{ color: 'var(--ui-text-color)' }} />,
}

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_COLOR: Record<string, string> = {
  running: 'processing',
  done: 'success',
  failed: 'error',
  cancelled: 'default',
}

function truncate(s: string | undefined, max = 60): string {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

function SubagentRow({
  task,
  onInterrupt,
}: {
  task: DshSubagentTask
  onInterrupt: (id: string) => void
}) {
  const status = task.status
  const isRunning = status === 'running'
  return (
    <div
      data-testid={`subagent-row-${task.id}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: 4,
        color: 'var(--text-primary)',
        fontSize: 12,
        borderBottom: '1px solid var(--border-color, #eee)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', minWidth: 16 }}>
        {STATUS_ICON[status] ?? <CloseCircleFilled />}
      </span>
      <Tag color={STATUS_COLOR[status]} style={{ margin: 0, fontSize: 10 }}>
        {STATUS_LABEL[status] ?? status}
      </Tag>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {truncate(task.description)}
      </span>
      <code style={{ fontSize: 10, color: 'var(--ui-text-color)' }}>{task.id.slice(-12)}</code>
      {isRunning && (
        <Tooltip title="中断这个子 agent 任务">
          <Button
            size="small"
            type="text"
            icon={<StopOutlined />}
            onClick={() => onInterrupt(task.id)}
            data-testid={`subagent-interrupt-${task.id}`}
          />
        </Tooltip>
      )}
    </div>
  )
}

export function SubagentsDrawer({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { tasks, loading, error, refresh } = useSubagentTasks()

  async function handleInterrupt(taskId: string) {
    const res = await interruptSubagentTask(taskId)
    if (!res.ok) {
      console.warn('[SubagentsDrawer] interrupt failed:', res.error)
    }
    // 立即 refresh — 不用等 5s 轮询
    refresh()
  }

  const running = tasks.filter((t) => t.status === 'running').length
  const finished = tasks.length - running

  return (
    <Drawer
      title={
        <Space>
          <span>Subagents</span>
          {running > 0 && (
            <Tag color="processing" style={{ marginLeft: 4 }}>
              {running} 运行中
            </Tag>
          )}
          {finished > 0 && (
            <Tag color="default" style={{ marginLeft: 4 }}>
              {finished} 已完成
            </Tag>
          )}
        </Space>
      }
      placement="right"
      width={420}
      open={open}
      onClose={onClose}
      extra={
        <Tooltip title="立即刷新">
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined spin={loading} />}
            onClick={refresh}
            data-testid="subagents-refresh"
          />
        </Tooltip>
      }
    >
      {error && (
        <div style={{ padding: 8, color: 'var(--error)', fontSize: 12 }}>
          加载失败: {error}
        </div>
      )}
      {tasks.length === 0 && !loading && !error && (
        <Empty
          description={
            <span style={{ color: 'var(--ui-text-color)', fontSize: 12 }}>
              当前 session 没有 dsh subagent 任务。<br />
              让 LLM 调 Agent 工具(描述简短)即可在此查看。
            </span>
          }
          imageStyle={{ height: 80 }}
        />
      )}
      {tasks.length > 0 && (
        <div>
          {tasks.map((t) => (
            <SubagentRow key={t.id} task={t} onInterrupt={handleInterrupt} />
          ))}
        </div>
      )}
    </Drawer>
  )
}
