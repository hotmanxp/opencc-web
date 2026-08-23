/**
 * dsh-019: dsh-mode subagent 任务 Tab(对齐 FsTab/GitTab/BashTab)。
 *
 * Phase 3 P0-B 新增:
 *   - 顶部 toggle: "当前 session" / "全部 session" — 切换 mode。
 *   - 'all' 模式下按 parentSessionId 分组显示,每组 header 标注 session。
 *   - mode 状态本地组件 useState(不持久化,刷新后回到 'current')。
 *
 * Phase 1 限制:
 *   - 5s 轮询(Phase 2 改 SSE 推送)
 *   - 不带详情 Drawer — 点 row 直接调 interrupt API
 *   - 不显示 prompt/startedAt 等元数据(等 dsh-bridge.listDshSubagents
 *     暴露详细字段再补)
 */

import { useState } from 'react'
import { Button, Empty, Input, Segmented, Space, Spin, Tag, Tooltip, message as antdMessage } from 'antd'
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
  type SubagentTasksMode,
} from '../../hooks/useSubagentTasks.js'
import { SubagentDetailDrawer } from './SubagentDetailDrawer.js'

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
  onSelect,
}: {
  task: DshSubagentTask
  onInterrupt: (id: string) => void
  busy: string | null
  onSendMessage: (id: string, message: string) => void
  sendingTo: string | null
  onSelect: (id: string) => void
}) {
  // Phase 3 P0-B 防御:cold-start / SSE 与 fetch 切换瞬间 task 可能没 id
  // (zustand selector 在 cold-start 返回 EMPTY,但 React render 已
  //  入栈) — 直接不 render row,避免 `task.id.slice` 抛 TypeError。
  if (!task?.id) return null
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
        cursor: 'pointer',
      }}
      onClick={() => onSelect(task.id)}
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
          <Tooltip title="给这个子 agent 发消息" aria-label="给子 agent 发消息提示">
            <Button
              size="small"
              type="text"
              icon={isSending ? <LoadingOutlined spin /> : <MessageOutlined />}
              aria-label="给子 agent 发消息"
              disabled={isSending}
              onClick={(e) => {
                e.stopPropagation()
                setShowInput((v) => !v)
              }}
              data-testid={`subagent-sendmsg-toggle-${task.id}`}
            />
          </Tooltip>
        )}
        {isRunning && (
          <Tooltip title="中断这个子 agent 任务" aria-label="中断子 agent 提示">
            <Button
              size="small"
              type="text"
              danger
              icon={isBusy ? <LoadingOutlined spin /> : <StopOutlined />}
              aria-label="中断子 agent 任务"
              disabled={isBusy}
              onClick={(e) => {
                e.stopPropagation()
                onInterrupt(task.id)
              }}
              data-testid={`subagent-interrupt-${task.id}`}
            />
          </Tooltip>
        )}
      </div>
      {showInput && isRunning && (
        <div
          style={{ display: 'flex', gap: 4, paddingLeft: 26 }}
          onClick={(e) => e.stopPropagation()}
        >
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
            aria-label="发送消息给子 agent"
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
  // Phase 3 P0-B: mode 状态 — 'current' 默认,'all' 跨 session 视图
  const [mode, setMode] = useState<SubagentTasksMode>('current')
  const { tasks, loading, error, refresh } = useSubagentTasks({ mode })
  const [busy, setBusy] = useState<string | null>(null)
  const [sendingTo, setSendingTo] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  async function handleInterrupt(taskId: string) {
    setBusy(taskId)
    try {
      const res = await interruptSubagentTask(taskId)
      if (!res.ok) {
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

  // Phase 3 P0-B: 'all' 模式按 parentSessionId 分组
  const grouped = mode === 'all' && tasks.length > 0
    ? (() => {
        const map = new Map<string, DshSubagentTask[]>()
        for (const t of tasks) {
          const key = (t as DshSubagentTask & { parentSessionId?: string }).parentSessionId ?? '(unknown)'
          if (!map.has(key)) map.set(key, [])
          map.get(key)!.push(t)
        }
        return Array.from(map.entries())
      })()
    : null

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
          gap: 8,
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
        <Space size={4}>
          <Segmented
            size="small"
            value={mode}
            onChange={(v) => setMode(v as SubagentTasksMode)}
            options={[
              { label: '当前', value: 'current' },
              { label: '全部', value: 'all' },
            ]}
            data-testid="subagents-mode-toggle"
          />
          <Tooltip title="立即刷新" aria-label="刷新提示">
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined spin={loading} />}
              aria-label="刷新 Subagents 列表"
              onClick={refresh}
              disabled={loading}
              data-testid="subagents-refresh"
            />
          </Tooltip>
        </Space>
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
                {mode === 'current'
                  ? '当前 session 没有 dsh subagent 任务。让 LLM 调 Agent 工具即可在此查看 + 中止 + 投消息。'
                  : '所有 session 都没有 dsh subagent 任务。'}
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
        {/* 'all' 模式按 parentSessionId 分组 */}
        {grouped
          ? grouped.map(([sessionId, groupTasks]) => (
              <div key={sessionId} data-testid={`subagents-group-${sessionId}`}>
                <div
                  style={{
                    padding: '6px 12px',
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--ui-text-color)',
                    background: 'var(--bg-card, #f5f5f5)',
                    borderBottom: '1px solid var(--border-color, #eee)',
                    fontFamily: 'monospace',
                  }}
                  title={sessionId}
                >
                  {sessionId}
                  <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--text-secondary)' }}>
                    ({groupTasks.length})
                  </span>
                </div>
                {groupTasks.map((t) => (
                  <SubagentRow
                    key={t.id}
                    task={t}
                    onInterrupt={handleInterrupt}
                    busy={busy}
                    onSendMessage={handleSendMessage}
                    sendingTo={sendingTo}
                    onSelect={setSelectedTaskId}
                  />
                ))}
              </div>
            ))
          : /* 'current' 模式直接渲染 */
          tasks.map((t) => (
            <SubagentRow
              key={t.id}
              task={t}
              onInterrupt={handleInterrupt}
              busy={busy}
              onSendMessage={handleSendMessage}
              sendingTo={sendingTo}
              onSelect={setSelectedTaskId}
            />
          ))}
      </div>
      <SubagentDetailDrawer
        taskId={selectedTaskId}
        onClose={() => setSelectedTaskId(null)}
        onInterrupt={handleInterrupt}
        busy={busy}
      />
    </div>
  )
}
