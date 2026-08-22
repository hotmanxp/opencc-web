/**
 * dsh-019: dsh-mode subagent 任务 Tab(对齐 FsTab/GitTab/BashTab)。
 *
 * 极简实现:直接复用 useSubagentTasks hook + SubagentRow 渲染。
 * 不进 Drawer 套娃(简化 + 跟其他 tab 一致),用户开/关 tab 即看/不看。
 *
 * Phase 1 限制:
 *   - 5s 轮询(Phase 2 改 SSE 推送)
 *   - 不带详情 Drawer — 点 row 直接调 interrupt API
 *   - 不显示 prompt/startedAt 等元数据(等 dsh-bridge.listDshSubagents
 *     暴露详细字段再补)
 */

import { useState } from 'react'
import { Button, Empty, Input, Space, Spin, Tag, Tooltip, message as antdMessage } from 'antd'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  MessageOutlined,
  ReloadOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons'
import {
  useSubagentTasks,
  interruptSubagentTask,
  sendMessageToSubagentTask,
  type DshSubagentTask,
} from '../../hooks/useSubagentTasks.js'

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

function SubagentRow({
  task,
  onInterrupt,
  busy,
  onSendMessage,
  sendingTo,
}: {
  task: DshSubagentTask
  onInterrupt: (id: string) => void
  busy: string | null
  onSendMessage: (id: string, message: string) => void
  sendingTo: string | null
}) {
  const status = task.status
  const isRunning = status === 'running'
  const isBusy = busy === task.id
  const isSending = sendingTo === task.id
  const [showInput, setShowInput] = useState(false)
  const [message, setMessage] = useState('')

  function handleSend() {
    const trimmed = message.trim()
    if (!trimmed) return
    onSendMessage(task.id, trimmed)
    setMessage('')
    setShowInput(false)
  }

  return (
    <div
      data-testid={`subagent-row-${task.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '8px 12px',
        borderBottom: '1px solid var(--border-color, #eee)',
        color: 'var(--text-primary)',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'flex', alignItems: 'center', minWidth: 18 }}>
          {STATUS_ICON[status] ?? <CloseCircleFilled />}
        </span>
        <Tag color={STATUS_COLOR[status]} style={{ margin: 0, fontSize: 10 }}>
          {STATUS_LABEL[status] ?? status}
        </Tag>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={task.description ?? task.id}
        >
          {task.description || '(no description)'}
        </span>
        <code
          style={{
            fontSize: 10,
            color: 'var(--ui-text-color)',
            fontFamily: 'monospace',
          }}
          title={task.id}
        >
          {task.id.slice(-12)}
        </code>
        {isRunning && (
          <Tooltip title="给这个子 agent 发消息">
            <Button
              size="small"
              type="text"
              icon={isSending ? <LoadingOutlined spin /> : <MessageOutlined />}
              disabled={isSending}
              onClick={() => setShowInput((v) => !v)}
              data-testid={`subagent-sendmsg-toggle-${task.id}`}
            />
          </Tooltip>
        )}
        {isRunning && (
          <Tooltip title="中断这个子 agent 任务">
            <Button
              size="small"
              type="text"
              danger
              icon={isBusy ? <LoadingOutlined spin /> : <StopOutlined />}
              disabled={isBusy}
              onClick={() => onInterrupt(task.id)}
              data-testid={`subagent-interrupt-${task.id}`}
            />
          </Tooltip>
        )}
      </div>
      {showInput && isRunning && (
        <div style={{ display: 'flex', gap: 4, paddingLeft: 26 }}>
          <Input.TextArea
            size="small"
            rows={2}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="给子 agent 投消息(下轮 turn 消费)…"
            disabled={isSending}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            data-testid={`subagent-sendmsg-input-${task.id}`}
            style={{ flex: 1, fontSize: 12 }}
          />
          <Button
            size="small"
            type="primary"
            icon={isSending ? <LoadingOutlined spin /> : <SendOutlined />}
            disabled={isSending || !message.trim()}
            onClick={handleSend}
            data-testid={`subagent-sendmsg-send-${task.id}`}
          />
        </div>
      )}
    </div>
  )
}

export function SubagentsTab() {
  const { tasks, loading, error, refresh } = useSubagentTasks()
  const [busy, setBusy] = useState<string | null>(null)
  const [sendingTo, setSendingTo] = useState<string | null>(null)

  async function handleInterrupt(taskId: string) {
    setBusy(taskId)
    try {
      const res = await interruptSubagentTask(taskId)
      if (!res.ok) {
        console.warn('[SubagentsTab] interrupt failed:', res.error)
        antdMessage.warning(`中断失败: ${res.error ?? 'unknown'}`)
      } else {
        antdMessage.success('已发送 interrupt 给子 agent')
      }
    } finally {
      setBusy(null)
    }
  }

  async function handleSendMessage(taskId: string, message: string) {
    setSendingTo(taskId)
    try {
      const res = await sendMessageToSubagentTask(taskId, message)
      if (!res.ok) {
        antdMessage.warning(`投消息失败: ${res.error ?? 'unknown'}`)
      } else {
        antdMessage.success('已投消息到子 agent 下一轮 turn')
      }
    } finally {
      setSendingTo(null)
    }
  }

  const running = tasks.filter((t) => t.status === 'running').length
  const total = tasks.length

  return (
    <div
      data-testid="subagents-tab"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 12px',
          borderBottom: '1px solid var(--border-color, #eee)',
          background: 'var(--bg-tab, transparent)',
        }}
      >
        <Space size="small">
          <span style={{ fontSize: 12, fontWeight: 600 }}>Subagents</span>
          {running > 0 && (
            <Tag color="processing" style={{ fontSize: 10 }}>
              {running} 运行中
            </Tag>
          )}
          {total > 0 && (
            <Tag style={{ fontSize: 10 }}>{total} 全部</Tag>
          )}
        </Space>
        <Tooltip title="立即刷新">
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined spin={loading} />}
            onClick={refresh}
            disabled={loading}
            data-testid="subagents-refresh"
          />
        </Tooltip>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {error && (
          <div style={{ padding: 12, color: 'var(--error)', fontSize: 12 }}>
            加载失败: {error}
          </div>
        )}
        {tasks.length === 0 && !loading && !error && (
          <Empty
            description={
              <span style={{ color: 'var(--ui-text-color)', fontSize: 12 }}>
                当前 session 没有 dsh subagent 任务。<br />
                让 LLM 调 Agent 工具即可在此查看 + 中止 + 投消息。
              </span>
            }
            imageStyle={{ height: 80 }}
          />
        )}
        {loading && tasks.length === 0 && (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        )}
        {tasks.map((t) => (
          <SubagentRow
            key={t.id}
            task={t}
            onInterrupt={handleInterrupt}
            busy={busy}
            onSendMessage={handleSendMessage}
            sendingTo={sendingTo}
          />
        ))}
      </div>
    </div>
  )
}
