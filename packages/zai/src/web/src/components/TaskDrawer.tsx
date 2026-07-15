import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Drawer, Empty, Tag, Tooltip } from 'antd'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  StopOutlined,
} from '@ant-design/icons'
import {
  cancelTask,
  fetchTask,
  subscribeTaskEvents,
  type BackgroundTask,
  type SseFrame,
} from '../lib/taskApi.js'

interface ToolCallEntry {
  toolUseId: string
  name: string
  input?: unknown
  output?: unknown
  error?: unknown
  status: 'running' | 'done' | 'error' | 'invalid' | 'denied'
  ts: number
}

interface StreamedEvent {
  seq: number
  type: string
  ts: number
  text?: string
  data: Record<string, unknown>
}

const STATUS_META: Record<string, { color: string; label: string; icon: JSX.Element }> = {
  running: { color: '#a78bfa', label: '运行中', icon: <LoadingOutlined spin /> },
  queued: { color: 'rgba(255,255,255,0.55)', label: '排队中', icon: <LoadingOutlined /> },
  completed: { color: '#52c41a', label: '完成', icon: <CheckCircleFilled /> },
  failed: { color: '#f5222d', label: '失败', icon: <CloseCircleFilled /> },
  cancelled: { color: 'rgba(255,255,255,0.40)', label: '已取消', icon: <CloseCircleFilled /> },
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rs = Math.floor(s % 60)
  return `${m}m${rs}s`
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function ToolCallCard({ entry }: { entry: ToolCallEntry }) {
  const borderColor =
    entry.status === 'error' || entry.status === 'invalid' || entry.status === 'denied'
      ? '#f5222d'
      : entry.status === 'done'
        ? '#52c41a'
        : '#a78bfa'

  return (
    <div
      style={{
        borderLeft: `3px solid ${borderColor}`,
        background: 'rgba(255,255,255,0.04)',
        padding: '8px 12px',
        borderRadius: 4,
        margin: '6px 0',
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 4,
        }}
      >
        <span style={{ fontFamily: 'ui-monospace, monospace', color: '#fff' }}>
          🔧 {entry.name}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>
          {entry.status}
        </span>
      </div>
      {entry.input !== undefined && (
        <details style={{ marginTop: 4 }}>
          <summary
            style={{
              color: 'rgba(255,255,255,0.55)',
              cursor: 'pointer',
              fontSize: 11,
              padding: '2px 0',
            }}
          >
            input
          </summary>
          <pre
            style={{
              margin: '4px 0 0',
              padding: 8,
              background: 'rgba(0,0,0,0.30)',
              borderRadius: 4,
              fontSize: 11,
              maxHeight: 160,
              overflow: 'auto',
              color: 'rgba(255,255,255,0.75)',
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            {formatJson(entry.input)}
          </pre>
        </details>
      )}
      {entry.output !== undefined && (
        <details style={{ marginTop: 4 }} open>
          <summary
            style={{
              color: 'rgba(255,255,255,0.55)',
              cursor: 'pointer',
              fontSize: 11,
              padding: '2px 0',
            }}
          >
            output
          </summary>
          <pre
            style={{
              margin: '4px 0 0',
              padding: 8,
              background: 'rgba(0,0,0,0.30)',
              borderRadius: 4,
              fontSize: 11,
              maxHeight: 240,
              overflow: 'auto',
              color: 'rgba(255,255,255,0.75)',
              fontFamily: 'ui-monospace, monospace',
              whiteSpace: 'pre-wrap',
            }}
          >
            {formatJson(entry.output)}
          </pre>
        </details>
      )}
      {entry.error !== undefined && (
        <pre
          style={{
            margin: '4px 0 0',
            padding: 8,
            background: 'rgba(245,34,45,0.10)',
            borderRadius: 4,
            fontSize: 11,
            color: '#f5222d',
            fontFamily: 'ui-monospace, monospace',
            whiteSpace: 'pre-wrap',
          }}
        >
          {formatJson(entry.error)}
        </pre>
      )}
    </div>
  )
}

/**
 * 把事件流聚合成两类展示单元:
 * - 累积文本(text deltas)
 * - 工具调用(tool_use:start / done / error / invalid / denied)
 */
function buildTimeline(events: StreamedEvent[]): Array<
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; key: string; entry: ToolCallEntry }
  | { kind: 'system'; key: string; label: string; tone: 'ok' | 'err' | 'neutral' }
> {
  const out: Array<
    | { kind: 'text'; key: string; text: string }
    | { kind: 'tool'; key: string; entry: ToolCallEntry }
    | { kind: 'system'; key: string; label: string; tone: 'ok' | 'err' | 'neutral' }
  > = []
  const toolById = new Map<string, ToolCallEntry>()
  let pendingText = ''

  for (const ev of events) {
    const data = ev.data
    switch (ev.type) {
      case 'content_block_delta': {
        const delta = data.delta as { type?: string; text?: string; thinking?: string } | undefined
        if (delta?.type === 'text_delta' && delta.text) {
          pendingText += delta.text
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          pendingText += delta.thinking
        }
        break
      }
      case 'message_stop':
      case 'tool_use:start':
      case 'tool_use:done':
      case 'tool_use:error':
      case 'tool_use:invalid':
      case 'tool_use:denied': {
        if (pendingText) {
          out.push({ kind: 'text', key: `text-${ev.seq}`, text: pendingText })
          pendingText = ''
        }
        const toolUseId = String((data as { toolUseId?: string }).toolUseId ?? '')
        if (!toolUseId) break
        const existing = toolById.get(toolUseId)
        if (ev.type === 'tool_use:start') {
          const entry: ToolCallEntry = {
            toolUseId,
            name: String((data as { name?: string }).name ?? 'tool'),
            input: (data as { input?: unknown }).input,
            status: 'running',
            ts: ev.ts,
          }
          toolById.set(toolUseId, entry)
          out.push({ kind: 'tool', key: `tool-${ev.seq}`, entry })
        } else if (existing) {
          if (ev.type === 'tool_use:done') {
            existing.status = 'done'
            existing.output = (data as { output?: unknown }).output
          } else if (ev.type === 'tool_use:error') {
            existing.status = 'error'
            existing.error = (data as { error?: unknown }).error
          } else if (ev.type === 'tool_use:invalid') {
            existing.status = 'invalid'
            existing.error = data
          } else if (ev.type === 'tool_use:denied') {
            existing.status = 'denied'
            existing.error = data
          }
          // 更新现有工具条目(通过 key 重渲染)
          const idx = out.findIndex((o) => o.kind === 'tool' && o.entry.toolUseId === toolUseId)
          if (idx >= 0) out[idx] = { kind: 'tool', key: `tool-${toolUseId}-${ev.seq}`, entry: { ...existing } }
        }
        break
      }
      case 'runtime.done':
        if (pendingText) {
          out.push({ kind: 'text', key: `text-${ev.seq}`, text: pendingText })
          pendingText = ''
        }
        out.push({ kind: 'system', key: `sys-${ev.seq}`, label: '✓ runtime.done', tone: 'ok' })
        break
      case 'runtime.error': {
        if (pendingText) {
          out.push({ kind: 'text', key: `text-${ev.seq}`, text: pendingText })
          pendingText = ''
        }
        const err = (data as { error?: { message?: string } }).error
        out.push({ kind: 'system', key: `sys-${ev.seq}`, label: `✗ runtime.error: ${err?.message ?? 'unknown'}`, tone: 'err' })
        break
      }
      case 'runtime.aborted':
        out.push({ kind: 'system', key: `sys-${ev.seq}`, label: '⏹ runtime.aborted', tone: 'neutral' })
        break
      case 'task.ended':
        out.push({ kind: 'system', key: `task-${ev.seq}`, label: `task.ended status=${(data as { status?: string }).status ?? '?'}`, tone: (data as { status?: string }).status === 'completed' ? 'ok' : 'neutral' })
        break
    }
  }
  if (pendingText) out.push({ kind: 'text', key: 'text-tail', text: pendingText })
  return out
}

export function TaskDrawer({
  taskId,
  onClose,
}: {
  taskId: string | null
  onClose: () => void
}) {
  const [detail, setDetail] = useState<BackgroundTask | null>(null)
  const [events, setEvents] = useState<StreamedEvent[]>([])
  const [loading, setLoading] = useState(false)
  const aborterRef = useRef<AbortController | null>(null)

  // 打开 task 时拉详情 + 订阅
  useEffect(() => {
    if (!taskId) {
      setDetail(null)
      setEvents([])
      return
    }
    setLoading(true)
    let cancelled = false
    void (async () => {
      try {
        const t = await fetchTask(taskId)
        if (cancelled) return
        setDetail(t)
      } catch (err) {
        console.warn('[TaskDrawer] fetch task failed:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    // 订阅事件流(从已读 eventCount 续读)
    const ac = new AbortController()
    aborterRef.current = ac
    void (async () => {
      try {
        const startSeq = (await fetchTask(taskId))?.eventCount
        if (cancelled || startSeq === undefined) return
        for await (const frame of subscribeTaskEvents(taskId, startSeq, ac.signal)) {
          if (cancelled) break
          handleFrame(frame)
        }
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return
        console.warn('[TaskDrawer] subscribe events failed:', err)
      }
    })()

    function handleFrame(frame: SseFrame) {
      const data = frame.data as StreamedEvent['data']
      // task.ended 哨兵:更新 detail 状态
      if (frame.event === 'task.ended') {
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                status: ((data as { status?: string }).status as BackgroundTask['status']) ?? prev.status,
                resultText: (data as { resultText?: string }).resultText ?? prev.resultText,
                finishedAt: Date.now(),
              }
            : prev,
        )
        return
      }
      setEvents((prev) => [
        ...prev,
        {
          seq: frame.id,
          type: frame.event,
          ts: (data as { ts?: number }).ts ?? Date.now(),
          data,
        },
      ])
    }

    return () => {
      cancelled = true
      ac.abort()
      aborterRef.current = null
    }
  }, [taskId])

  const timeline = useMemo(() => buildTimeline(events), [events])
  const meta = detail ? STATUS_META[detail.status] : null
  const duration =
    detail?.startedAt && (detail.finishedAt || detail.status === 'running')
      ? formatDuration((detail.finishedAt ?? Date.now()) - detail.startedAt)
      : null

  return (
    <Drawer
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>后台 Agent</span>
          {detail && (
            <Tag color={meta?.color} style={{ margin: 0 }}>
              {meta?.icon} {meta?.label}
            </Tag>
          )}
          {duration && (
            <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>{duration}</span>
          )}
        </div>
      }
      placement="right"
      width={560}
      open={!!taskId}
      onClose={onClose}
      destroyOnClose
      styles={{ body: { padding: 0, background: '#141414', color: '#fff' } }}
      extra={
        detail && detail.status === 'running' ? (
          <Button
            danger
            size="small"
            icon={<StopOutlined />}
            onClick={async () => {
              try {
                await cancelTask(detail.id, 'user cancelled')
              } catch (err) {
                console.warn('[TaskDrawer] cancel failed:', err)
              }
            }}
          >
            取消
          </Button>
        ) : null
      }
    >
      {loading && !detail && (
        <div style={{ padding: 24, textAlign: 'center', color: 'rgba(255,255,255,0.45)' }}>
          <LoadingOutlined /> 加载中...
        </div>
      )}
      {detail && (
        <>
          {/* 头部信息 */}
          <div
            style={{
              padding: '12px 20px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              background: '#1a1a1a',
            }}
          >
            <div
              style={{
                fontSize: 13,
                color: '#fff',
                marginBottom: 8,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {detail.input.prompt}
            </div>
            <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
              {detail.input.model && <span>模型: {detail.input.model}</span>}
              {detail.input.cwd && (
                <Tooltip title={detail.input.cwd}>
                  <span>cwd: {detail.input.cwd.split('/').slice(-2).join('/')}</span>
                </Tooltip>
              )}
              <span>事件: {events.length}</span>
              <span>id: {detail.id}</span>
            </div>
            {/* Retry chip: 当 task 因为 529/429/5xx 触发自动重试, attemptCount > 1
                时显示. 让用户知道"原本只失败 1 次, 但 BackgroundRuntime 已自动
                重试 N-1 次". */}
            {detail.attemptCount !== undefined &&
              detail.attemptCount > 1 && (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.65)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    background: 'rgba(168, 139, 250, 0.12)',
                    border: '1px solid rgba(168, 139, 250, 0.30)',
                    borderRadius: 4,
                  }}
                >
                  ↻ 已重试 {detail.attemptCount - 1} 次 (529 / 429 / 5xx 瞬时错误)
                </div>
              )}
          </div>

          {/* 时间线 */}
          <div style={{ padding: '12px 20px', minHeight: 200 }}>
            {timeline.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="等待事件..."
                style={{ color: 'rgba(255,255,255,0.40)' }}
              />
            ) : (
              timeline.map((item) => {
                if (item.kind === 'text') {
                  return (
                    <div
                      key={item.key}
                      style={{
                        fontSize: 13,
                        color: '#fff',
                        padding: '6px 0',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {item.text}
                    </div>
                  )
                }
                if (item.kind === 'tool') {
                  return <ToolCallCard key={item.key} entry={item.entry} />
                }
                return (
                  <div
                    key={item.key}
                    style={{
                      fontSize: 11,
                      padding: '6px 0',
                      color:
                        item.tone === 'err'
                          ? '#f5222d'
                          : item.tone === 'ok'
                            ? '#52c41a'
                            : 'rgba(255,255,255,0.45)',
                      fontFamily: 'ui-monospace, monospace',
                    }}
                  >
                    {item.label}
                  </div>
                )
              })
            )}
          </div>
        </>
      )}
    </Drawer>
  )
}