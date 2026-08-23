/**
 * dsh-019 Phase 3: dsh subagent 任务详情 — 不含 Drawer 外壳的纯内容组件。
 *
 * 与 `SubagentDetailDrawer` 共享渲染逻辑(Descriptions / PromptBlock /
 * Tool Calls Collapse / Result),由不同宿主决定如何包装:
 *
 * - `SubagentDetailDrawer` — 包成独立 Drawer 给 SubagentsTab 用
 * - `TaskDrawer` (dsh subagent 分支) — 直接渲染在 TaskDrawer 内,
 *   不嵌套 Drawer(避免两层 Drawer 的视觉问题,见 plan
 *   `squishy-cuddling-allen.md` 改动 2 第 6 步)
 *
 * 数据源:`GET /api/subagent-tasks/:id` 拉完整 DshTaskState(prompt /
 * startedAt / finishedAt / result / error / toolCalls)。父组件通过
 * SSE `subagent.changed` 推 store 拿到 status 实时更新,本组件 fetch
 * 只在 taskId 变化时跑一次。
 */

import { useEffect, useState } from 'react'
import { Collapse, Descriptions, Spin, Typography } from 'antd'
import { CodeOutlined } from '@ant-design/icons'
import { useAgentStore } from '../../store/useAgentStore.js'

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

/**
 * dsh 给的 tool input 是模型生成的 raw JSON 字符串(arguments 字段),
 * 摘要取前 80 字符做单行展示。
 */
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

export function SubagentDetailBody({
  taskId,
  reloadSignal = 0,
}: {
  taskId: string
  /**
   * 父组件递增这个 number 触发重 fetch。SubagentDetailDrawer 用此支持
   * Reload 按钮。TaskDrawer 嵌入本组件时通常传 0(不重 fetch,实时性靠 SSE)。
   */
  reloadSignal?: number
}) {
  const [detail, setDetail] = useState<SubagentDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // dsh-024 修复:订阅 store 里的 live status — SSE 'subagent.changed'
  // 推到 useAgentStore.subagentTasksBySession,触发组件 re-render。
  // 当 status 从 'running' 变为终态(done/failed/cancelled)时,触发
  // 重新 fetch — 因为 body 内容(result / toolCalls / finishedAt)只
  // 在 taskStore 落盘时更新,SSE 事件本身只携带 status 字段;不重新
  // 拉详情抽屉里就显示不出 Agent 的最终回复,只能刷新页面才能看到
  // (用户痛点:「完成之后,看不到 Agent 的回复,但是刷新页面重新加载
  // 又看到了思考和结果展示」)。
  const liveStatus = useAgentStore((s) => {
    for (const sid of Object.keys(s.subagentTasksBySession)) {
      const t = s.subagentTasksBySession[sid]?.find((task) => task.id === taskId)
      if (t) return t.status as SubagentDetail['status'] | undefined
    }
    return undefined
  })

  // 拉详情 — taskId 变化 / reloadSignal 递增 / liveStatus 变化时
  // 重新 fetch。running → terminal 的状态切换是关键触发点。
  useEffect(() => {
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
  }, [taskId, reloadSignal, liveStatus])

  if (loading && !detail) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <Spin />
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ padding: 16, color: 'var(--error)', fontSize: 13 }}>
        加载失败: {error}
      </div>
    )
  }
  if (!detail) return null

  return (
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
  )
}