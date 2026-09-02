import { useEffect, useMemo, useState } from 'react'
import { Drawer, Tabs, Typography, Spin, Timeline, Collapse } from 'antd'
import type { CSSProperties } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchSuperTaskDetail } from '../../lib/superTaskApi'
import { subscribeTaskEvents } from '../../lib/taskApi'
import type { TaskDetails } from '../../lib/superTaskApi'
import { toRendered, type RenderedEvent } from './processEventRenderer'

/** 执行过程事件帧（taskApi.subscribeTaskEvents 产出，字段对齐 taskApi.SseFrame）。 */
interface EventFrame {
  id: string | number
  event: string
  data: Record<string, unknown> | null
}

/**
 * 工具调用/结果的展开状态 —— component 局部 useState，关闭抽屉 / 卸载组件
 * 时丢，不进 URL 不进 store。AntD Tabs 默认 destroyInactiveTabPane=false,
 * 切 tab 不重挂载 → 状态保留。
 */
interface Expansion {
  input?: boolean
  result?: boolean
}

/**
 * SuperTaskDetailDrawer — 任务详情抽屉（Task 10）。
 *
 * 抽屉打开后拉取任务详情（/api/super-tasks/:id），并在 open 期间每 3s 轮询
 * 刷新（process.md 增量追加）。任务已派生执行子 Agent（index.md 的
 * executorTaskId）时，执行过程 Tab 通过 `/api/tasks/:id/events` 订阅执行器
 * 的工具调用与消息流，缓冲最近 200 帧。
 */
export default function SuperTaskDetailDrawer({
  taskId,
  onClose,
}: {
  taskId: string | null
  onClose: () => void
}): JSX.Element {
  const [detail, setDetail] = useState<TaskDetails | null>(null)
  const [events, setEvents] = useState<EventFrame[]>([])

  // 详情拉取 + 3s 轮询（抽屉 open 期间持续刷新 process.md / spec.md / plan.md）
  useEffect(() => {
    if (!taskId) {
      setDetail(null)
      setEvents([])
      return
    }
    let cancelled = false
    setDetail(null)
    setEvents([])
    const load = async (): Promise<void> => {
      try {
        const d = await fetchSuperTaskDetail(taskId)
        if (!cancelled) setDetail(d)
      } catch {
        if (!cancelled) setDetail(null)
      }
    }
    void load()
    const pollId = window.setInterval(() => void load(), 3000)
    return () => {
      cancelled = true
      window.clearInterval(pollId)
    }
  }, [taskId])

  // executor 存在时订阅执行器事件流；executorTaskId 可能晚于首帧详情出现
  // （任务先创建、后派发执行子 Agent），因此以 detail 变化驱动订阅。
  const executorId = detail?.summary.executorTaskId ?? null
  useEffect(() => {
    if (!executorId) {
      setEvents([])
      return
    }
    const ctrl = new AbortController()
    const run = async (): Promise<void> => {
      try {
        for await (const frame of subscribeTaskEvents(executorId, 0, ctrl.signal)) {
          setEvents((p) => [...p, frame as EventFrame].slice(-200))
        }
      } catch {
        // abort / 流结束静默
      }
    }
    void run()
    return () => ctrl.abort()
  }, [executorId])

  // 把 SSE 帧流翻译成结构化渲染事件 —— 翻译规则全在 processEventRenderer.ts
  const rendered = useMemo(
    () =>
      events
        .map((e) =>
          toRendered({ id: e.id, event: e.event, data: e.data as unknown }),
        )
        .filter((r): r is RenderedEvent => r !== null),
    [events],
  )

  // 工具调用展开状态 —— 用 Map<toolUseId, {...}>，null 表示已渲染的
  // task-ended 行不算「工具调用」，不进 map。
  const [expanded, setExpanded] = useState<Map<string, Expansion>>(new Map())
  const toggleExpand = (key: string, field: keyof Expansion): void => {
    setExpanded((p) => {
      const cur = p.get(key) ?? {}
      const next = new Map(p)
      next.set(key, { ...cur, [field]: !(cur[field] ?? false) })
      return next
    })
  }

  return (
    <Drawer
      open={taskId != null}
      onClose={onClose}
      width={720}
      title={detail ? `任务 ${detail.summary.id}` : '任务详情'}
    >
      {!detail ? (
        <Spin />
      ) : (
        <>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            {detail.summary.title}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            状态:{detail.summary.status} · Agent:{detail.summary.agent ?? 'default'}
            {detail.summary.executorTaskId ? ` · 执行任务:${detail.summary.executorTaskId}` : ''}
          </Typography.Paragraph>
          <Tabs
            items={[
              {
                key: 'process',
                label: '执行过程',
                children: detail.summary.executorTaskId ? (
                  rendered.length > 0 ? (
                    <div style={{ maxHeight: 'calc(100vh - 280px)', overflow: 'auto' }}>
                      <Timeline
                        items={rendered.map((r) => ({
                          key: rowKey(r),
                          color: dotColor(r),
                          children: (
                            <RenderedEventRow
                              ev={r}
                              expanded={expanded}
                              toggle={toggleExpand}
                            />
                          ),
                        }))}
                      />
                    </div>
                  ) : (
                    <Typography.Text type="secondary">等待执行事件...</Typography.Text>
                  )
                ) : (
                  <Typography.Text type="secondary">尚未派生执行子 Agent</Typography.Text>
                ),
              },
              {
                key: 'spec',
                label: 'spec.md',
                children: <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.specMd ?? ''}</ReactMarkdown>,
              },
              {
                key: 'plan',
                label: 'plan.md',
                children: <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.planMd ?? ''}</ReactMarkdown>,
              },
              {
                key: 'processMd',
                label: 'process.md',
                children: <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.processMd ?? ''}</ReactMarkdown>,
              },
            ]}
          />
        </>
      )}
    </Drawer>
  )
}

/** Timeline 每行的 key —— 同 seq 不同 kind 也要区分,避免折叠键冲突。 */
function rowKey(r: RenderedEvent): string {
  if (r.kind === 'task-ended') return `ended-${r.status}`
  return `${r.seq}-${r.kind}`
}

/** Timeline 圆点颜色 —— 按 kind 分层(blue=assistant-text/red=error/gray=thinking etc.)。 */
function dotColor(r: RenderedEvent): string {
  switch (r.kind) {
    case 'system':
      return 'gray'
    case 'user':
      return 'green'
    case 'assistant-text':
      return 'blue'
    case 'thinking':
      return 'gray'
    case 'tool-use':
      return 'purple'
    case 'tool-result':
      return r.isError ? 'red' : 'gray'
    case 'task-ended':
      return r.status === 'completed' ? 'green' : r.status === 'failed' ? 'red' : 'gray'
  }
}

/** 工具调用/结果行的 JSON 面板 —— 渲染传入对象 + 折叠状态。 */
function JsonPanel({
  data,
  open,
  error,
}: {
  data: unknown
  open: boolean
  error?: boolean
}): JSX.Element {
  if (!open) return <span style={{ fontSize: 11, color: error ? '#c41d7f' : '#999' }}>▸</span>
  const style: CSSProperties = {
    marginTop: 4,
    padding: 8,
    background: error ? '#fff1f0' : '#fafafa',
    border: `1px solid ${error ? '#ffa39e' : '#e8e8e8'}`,
    borderRadius: 4,
    fontSize: 12,
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 240,
    overflow: 'auto',
  }
  return (
    <div style={style}>
      <code>{JSON.stringify(data, null, 2)}</code>
    </div>
  )
}

/** 思考块折叠 —— <Collapse> 包裹整段文本。 */
function ThinkingBlock({ text }: { text: string }): JSX.Element {
  return (
    <Collapse
      size="small"
      ghost
      items={[
        {
          key: 't',
          label: <span style={{ color: '#888' }}>[思考]</span>,
          children: <div style={{ whiteSpace: 'pre-wrap', color: '#555' }}>{text}</div>,
        },
      ]}
    />
  )
}

/** 7 种 kind 分支的渲染 —— 在 Timeline children 槽里。 */
function RenderedEventRow({
  ev,
  expanded,
  toggle,
}: {
  ev: RenderedEvent
  expanded: Map<string, Expansion>
  toggle: (key: string, field: keyof Expansion) => void
}): JSX.Element {
  switch (ev.kind) {
    case 'system':
      return (
        <span style={{ color: '#888' }}>
          <code>[{ev.sub}]</code>
        </span>
      )
    case 'user':
      return (
        <div>
          <blockquote
            style={{
              margin: '4px 0',
              padding: '4px 10px',
              borderLeft: '3px solid #52c41a',
              background: '#f6ffed',
            }}
          >
            {ev.text}
          </blockquote>
          {(ev.cwd || ev.agent) && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {ev.cwd ? `cwd: ${ev.cwd}` : ''}
              {ev.cwd && ev.agent ? ' · ' : ''}
              {ev.agent ? `agent: ${ev.agent}` : ''}
            </Typography.Text>
          )}
        </div>
      )
    case 'assistant-text':
      return (
        <div style={{ marginTop: 2 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{ev.text}</ReactMarkdown>
        </div>
      )
    case 'thinking':
      return <ThinkingBlock text={ev.text} />
    case 'tool-use': {
      const open = expanded.get(ev.toolUseId)?.input ?? false
      return (
        <div>
          <a
            onClick={(e) => {
              e.preventDefault()
              toggle(ev.toolUseId, 'input')
            }}
            style={{ color: '#722ed1', cursor: 'pointer' }}
          >
            [Tool: {ev.name}] {ev.summary} {open ? '▾' : '▸'}
          </a>
          <JsonPanel data={ev.fullInput} open={open} />
        </div>
      )
    }
    case 'tool-result': {
      const open = expanded.get(ev.toolUseId)?.result ?? false
      const color = ev.isError ? '#c41d7f' : '#666'
      return (
        <div style={{ marginTop: 2, paddingLeft: 12, borderLeft: '2px solid #eee' }}>
          <a
            onClick={(e) => {
              e.preventDefault()
              toggle(ev.toolUseId, 'result')
            }}
            style={{ color, cursor: 'pointer', fontSize: 13 }}
          >
            ↳ result · {ev.summary} {open ? '▾' : '▸'}
          </a>
          <JsonPanel data={ev.fullContent} open={open} error={ev.isError} />
        </div>
      )
    }
    case 'task-ended':
      if (ev.status === 'completed')
        return <span style={{ color: '#52c41a' }}>✓ 任务完成</span>
      if (ev.status === 'failed')
        return (
          <span style={{ color: '#ff4d4f' }}>
            ✗ 失败:{ev.error ?? '未知错误'}
          </span>
        )
      return <span style={{ color: '#999' }}>− 已取消</span>
  }
}
