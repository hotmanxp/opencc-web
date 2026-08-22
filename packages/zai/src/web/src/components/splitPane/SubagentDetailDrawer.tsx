/**
 * dsh-019 Phase 2: dsh subagent 任务详情 Drawer。
 *
 * 点 SubagentsTab row 时打开(右侧抽屉,半屏宽 480)。显示完整
 * DshTaskState: prompt / startedAt / finishedAt / status / error / result
 * (result 来自子 agent 自己的对话结果,可能很大,默认折叠到前 4K 字符)。
 *
 * Phase 3 P0-A: 新增 Tool Calls 块 — 渲染子 agent 自己的工具调用历史
 * (每个 tool/call + tool/result 对:工具名 + 输入摘要 + 状态 + 持续时间,
 *  点击展开 input/output 完整 JSON)。
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
import { Button, Collapse, Descriptions, Drawer, Spin, Tag, Tooltip, Typography } from 'antd'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CodeOutlined,
  LoadingOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons'

const { Paragraph } = Typography

export interface ToolCallView {
  callId: string
  toolName: string
  input: unknown
  output?: unknown
  status: 'running' | 'done' | 'error'
  ts: number
  durationMs?: number
  error?: { name: string; code: string }
}

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
  toolCalls?: ToolCallView[]
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

// Phase 3 P0-A: tool call status → 颜色 + 标签
const TOOL_STATUS_COLOR: Record<ToolCallView['status'], string> = {
  running: 'var(--warning)',
  done: 'var(--success)',
  error: 'var(--error)',
}

const TOOL_STATUS_LABEL: Record<ToolCallView['status'], string> = {
  running: '运行中',
  done: '完成',
  error: '失败',
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

function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
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

// Phase 3 P0-A: tool input 摘要 — 取 arguments 前 80 字符做单行展示。
// dsh 给的 input 是模型生成的 raw JSON 字符串(arguments 字段),直接 slice。
function formatToolInputSummary(toolName: string, input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') {
    const trimmed = input.length > 80 ? input.slice(0, 80) + '…' : input
    return `${toolName}(${trimmed})`
  }
  try {
    const s = JSON.stringify(input)
    const trimmed = s.length > 80 ? s.slice(0, 80) + '…' : s
    return `${toolName}(${trimmed})`
  } catch {
    return `${toolName}(?)`
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

          {detail.toolCalls && detail.toolCalls.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  marginBottom: 4,
                  color: 'var(--ui-text-color)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <CodeOutlined />
                Tool Calls ({detail.toolCalls.length})
              </div>
              <Collapse
                size="small"
                bordered={false}
                ghost
                items={detail.toolCalls.map((tc, idx) => ({
                  key: tc.callId || `tc-${idx}`,
                  label: (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 12,
                        fontFamily: 'ui-monospace, monospace',
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: 'var(--text-primary)',
                        }}
                      >
                        {formatToolInputSummary(tc.toolName, tc.input)}
                      </span>
                      <span
                        style={{
                          marginLeft: 'auto',
                          flexShrink: 0,
                          color: TOOL_STATUS_COLOR[tc.status],
                          fontSize: 11,
                        }}
                      >
                        {TOOL_STATUS_LABEL[tc.status]}
                        {tc.durationMs !== undefined && (
                          <> · {formatDurationShort(tc.durationMs)}</>
                        )}
                      </span>
                    </div>
                  ),
                  children: (
                    <div style={{ fontSize: 12 }}>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: 'var(--ui-text-color)',
                          marginBottom: 2,
                        }}
                      >
                        Input
                      </div>
                      <Paragraph
                        copyable
                        style={{
                          fontSize: 12,
                          background: 'var(--bg-card, #fafafa)',
                          padding: 8,
                          borderRadius: 4,
                          marginBottom: 8,
                          maxHeight: 240,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          fontFamily: 'ui-monospace, monospace',
                        }}
                      >
                        {typeof tc.input === 'string'
                          ? tc.input
                          : formatResult(tc.input) || '(empty)'}
                      </Paragraph>
                      {tc.output !== undefined && (
                        <>
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: 'var(--ui-text-color)',
                              marginBottom: 2,
                            }}
                          >
                            Output
                          </div>
                          <Paragraph
                            copyable
                            style={{
                              fontSize: 12,
                              background:
                                tc.status === 'error'
                                  ? 'var(--bg-card, #fff5f5)'
                                  : 'var(--bg-card, #fafafa)',
                              padding: 8,
                              borderRadius: 4,
                              marginBottom: 0,
                              maxHeight: 240,
                              overflow: 'auto',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              fontFamily: 'ui-monospace, monospace',
                              color: tc.status === 'error' ? 'var(--error)' : undefined,
                            }}
                          >
                            {formatResult(tc.output).slice(0, 4096) || '(empty)'}
                          </Paragraph>
                        </>
                      )}
                      {tc.error && (
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 11,
                            color: 'var(--error)',
                          }}
                        >
                          {tc.error.name} ({tc.error.code})
                        </div>
                      )}
                    </div>
                  ),
                }))}
              />
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
