/**
 * dsh-019 Phase 2: dsh subagent 任务详情 Drawer。
 *
 * 点 SubagentsTab row 时打开(右侧抽屉,半屏宽 480)。显示完整
 * DshTaskState: prompt / startedAt / finishedAt / status / error / result
 * (result 来自子 agent 自己的对话结果,可能很大,默认折叠到前 4K 字符)。
 *
 * 右上角操作:
 *   - 中断(only when status=running)
 *   - 关闭
 *
 * 拉详情走 GET /api/subagent-tasks/:id(优先用 dsh-bridge.readTask 完整
 * 状态,fallback 到 list 简略对象)。SSE 实时状态变化(SSE 推到
 * useAgentStore.subagentTasksBySession)同步 drawer 内的 status badge,
 * 避免"任务刚变 done 但 drawer 还显示 running"。
 */

import { useEffect, useState } from 'react'
import { Button, Descriptions, Drawer, Spin, Tag, Tooltip, Typography } from 'antd'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons'

const { Paragraph } = Typography

export interface SubagentDetail {
  taskId: string
  sessionId: string
  parentSessionId?: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  prompt: string
  startedAt: number
  finishedAt?: number
  result?: unknown
  error?: string
}

const STATUS_COLOR: Record<SubagentDetail['status'], string> = {
  running: 'processing',
  done: 'success',
  failed: 'error',
  cancelled: 'default',
}

const STATUS_LABEL: Record<SubagentDetail['status'], string> = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_ICON: Record<SubagentDetail['status'], JSX.Element> = {
  running: <LoadingOutlined style={{ color: 'var(--accent-start)' }} spin />,
  done: <CheckCircleFilled style={{ color: 'var(--success)' }} />,
  failed: <CloseCircleFilled style={{ color: 'var(--error)' }} />,
  cancelled: <CloseCircleFilled style={{ color: 'var(--ui-text-color)' }} />,
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

function formatDuration(start: number, end?: number): string {
  const endMs = end ?? Date.now()
  const ms = endMs - start
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

function formatResult(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

export function SubagentDetailDrawer({
  taskId,
  onClose,
  onInterrupt,
  busy,
}: {
  taskId: string | null
  onClose: () => void
  onInterrupt: (id: string) => void
  busy: string | null
}) {
  const [detail, setDetail] = useState<SubagentDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 拉详情 — taskId 变化时重新 fetch
  useEffect(() => {
    if (!taskId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/subagent-tasks/${encodeURIComponent(taskId)}`)
      .then((r) => {
        if (!r.ok) {
          if (r.status === 404) throw new Error('subagent_task_not_found')
          if (r.status === 503) throw new Error('dsh_subagent_unavailable')
          throw new Error(`HTTP ${r.status}`)
        }
        return r.json() as Promise<SubagentDetail>
      })
      .then((d) => {
        if (cancelled) return
        setDetail(d)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setDetail(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [taskId])

  const status = detail?.status
  const isRunning = status === 'running'
  const isBusy = busy === taskId

  return (
    <Drawer
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Subagent 详情</span>
          {status && (
            <Tag color={STATUS_COLOR[status]} icon={STATUS_ICON[status]}>
              {STATUS_LABEL[status]}
            </Tag>
          )}
        </span>
      }
      placement="right"
      width={520}
      open={!!taskId}
      onClose={onClose}
      destroyOnClose
      extra={
        <Space>
          <Tooltip title="重新拉取">
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined spin={loading} />}
              onClick={() => taskId && fetch(`/api/subagent-tasks/${encodeURIComponent(taskId)}`).then((r) => r.json()).then((d) => setDetail(d))}
              disabled={loading}
            />
          </Tooltip>
          {isRunning && (
            <Tooltip title="中断这个子 agent 任务">
              <Button
                size="small"
                danger
                icon={isBusy ? <LoadingOutlined spin /> : <StopOutlined />}
                disabled={isBusy}
                loading={isBusy}
                onClick={() => taskId && onInterrupt(taskId)}
              >
                Interrupt
              </Button>
            </Tooltip>
          )}
        </Space>
      }
    >
      {loading && !detail && (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      )}
      {error && (
        <div style={{ padding: 16, color: 'var(--error)', fontSize: 13 }}>
          加载失败: {error}
        </div>
      )}
      {detail && (
        <div>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Task ID">
              <code style={{ fontSize: 11 }}>{detail.taskId}</code>
            </Descriptions.Item>
            <Descriptions.Item label="Session ID">
              <code style={{ fontSize: 11 }}>{detail.sessionId}</code>
            </Descriptions.Item>
            {detail.parentSessionId && (
              <Descriptions.Item label="Parent Session">
                <code style={{ fontSize: 11 }}>{detail.parentSessionId}</code>
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Started At">
              {formatTimestamp(detail.startedAt)}
            </Descriptions.Item>
            {detail.finishedAt && (
              <Descriptions.Item label="Finished At">
                {formatTimestamp(detail.finishedAt)}
              </Descriptions.Item>
            )}
            {detail.startedAt && (
              <Descriptions.Item label="Duration">
                {formatDuration(detail.startedAt, detail.finishedAt)}
              </Descriptions.Item>
            )}
          </Descriptions>

          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--ui-text-color)' }}>
              Prompt
            </div>
            <Paragraph
              copyable={{ tooltips: ['复制', '已复制'] }}
              style={{
                fontSize: 12,
                background: 'var(--bg-card, #fafafa)',
                padding: 8,
                borderRadius: 4,
                marginBottom: 0,
                maxHeight: 200,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {detail.prompt || '(empty)'}
            </Paragraph>
          </div>

          {detail.error && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--error)' }}>
                Error
              </div>
              <Paragraph
                copyable
                style={{
                  fontSize: 12,
                  background: 'var(--bg-card, #fff5f5)',
                  padding: 8,
                  borderRadius: 4,
                  marginBottom: 0,
                  color: 'var(--error)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {detail.error}
              </Paragraph>
            </div>
          )}

          {detail.result !== undefined && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--ui-text-color)' }}>
                Result
              </div>
              <Paragraph
                copyable
                style={{
                  fontSize: 12,
                  background: 'var(--bg-card, #fafafa)',
                  padding: 8,
                  borderRadius: 4,
                  marginBottom: 0,
                  maxHeight: 300,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'monospace',
                }}
              >
                {formatResult(detail.result).slice(0, 4096) || '(empty)'}
              </Paragraph>
            </div>
          )}
        </div>
      )}
    </Drawer>
  )
}

// Antd Space helper (避免在文件顶层再 import)
function Space({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'inline-flex', gap: 8 }}>{children}</div>
}
