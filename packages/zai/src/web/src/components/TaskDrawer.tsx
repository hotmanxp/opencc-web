import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Badge, Button, Drawer, Empty, Tag, Tooltip } from 'antd'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  StopOutlined,
} from '@ant-design/icons'
import {
  cancelTask,
  killBashTask,
  subscribeTaskEvents,
  type BackgroundTask,
  type BashTaskInfo,
  type SseFrame,
} from '../lib/taskApi.js'
import { useAgentStore } from '../store/useAgentStore.js'

interface ToolCallEntry {
  toolUseId: string
  name: string
  input?: unknown
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

const CODE_BG = '#282c34'
const CODE_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

const markdownComponents = {
  p: ({ children }: any) => <p style={{ margin: '0 0 8px 0' }}>{children}</p>,
  h1: ({ children }: any) => <h1 style={{ fontSize: 20, fontWeight: 600, margin: '12px 0 8px 0' }}>{children}</h1>,
  h2: ({ children }: any) => <h2 style={{ fontSize: 18, fontWeight: 600, margin: '12px 0 8px 0' }}>{children}</h2>,
  h3: ({ children }: any) => <h3 style={{ fontSize: 16, fontWeight: 600, margin: '10px 0 6px 0' }}>{children}</h3>,
  h4: ({ children }: any) => <h4 style={{ fontSize: 14, fontWeight: 600, margin: '8px 0 4px 0' }}>{children}</h4>,
  ul: ({ children }: any) => <ul style={{ margin: '0 0 8px 0', paddingLeft: 20 }}>{children}</ul>,
  ol: ({ children }: any) => <ol style={{ margin: '0 0 8px 0', paddingLeft: 20 }}>{children}</ol>,
  li: ({ children }: any) => <li style={{ marginBottom: 4 }}>{children}</li>,
  code: ({ className, children }: any) => {
    const match = /language-(\w+)/.exec(className || '')
    if (!match) return <code style={{ background: 'transparent', color: '#a78bfa', padding: '1px 6px', borderRadius: 3, fontSize: '0.9em', fontFamily: CODE_FONT_FAMILY, fontWeight: 500 }}>{children}</code>
    return <SyntaxHighlighter language={match[1]} style={oneDark} customStyle={{ margin: '6px 0 10px 0', padding: '12px 14px', borderRadius: 6, fontSize: 12, lineHeight: 1.55, background: CODE_BG }} codeTagProps={{ style: { fontFamily: CODE_FONT_FAMILY } }} wrapLongLines={false} showLineNumbers={false}>{String(children).replace(/\n$/, '')}</SyntaxHighlighter>
  },
  pre: ({ children }: any) => <>{children}</>,
  table: ({ children }: any) => <table style={{ borderCollapse: 'collapse', margin: '4px 0 8px 0', fontSize: 13, width: '100%' }}>{children}</table>,
  thead: ({ children }: any) => <thead style={{ background: 'rgba(255,255,255,0.05)' }}>{children}</thead>,
  tbody: ({ children }: any) => <tbody>{children}</tbody>,
  tr: ({ children }: any) => <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>{children}</tr>,
  th: ({ children }: any) => <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, border: '1px solid rgba(255,255,255,0.08)' }}>{children}</th>,
  td: ({ children }: any) => <td style={{ padding: '6px 10px', border: '1px solid rgba(255,255,255,0.08)' }}>{children}</td>,
  blockquote: ({ children }: any) => <blockquote style={{ borderLeft: '3px solid rgba(255,255,255,0.2)', paddingLeft: 12, margin: '4px 0 8px 0', color: 'rgba(255,255,255,0.7)' }}>{children}</blockquote>,
  a: ({ href, children }: any) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#1677ff', textDecoration: 'underline' }}>{children}</a>,
  hr: () => <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.08)', margin: '12px 0' }} />,
}

export function MarkdownText({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 14,
        lineHeight: 1.6,
        color: 'inherit',
        wordBreak: 'break-word',
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

/**
 * 后台 Agent 头部"提示词"区域:
 * - 始终展示 `Prompt:` label + 文本
 * - 默认 2 行 (line-clamp) 折叠; 超过阈值时附"展开/收起"按钮
 * - 短文本 (<= 2 行 / 120 字符) 不显示按钮, 避免无意义交互
 */
const PROMPT_EXPAND_LINE_THRESHOLD = 2
const PROMPT_EXPAND_CHAR_THRESHOLD = 120
export function PromptBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  // 简单的"是否值得展开"启发式: 多行 (>= 3 个换行) 或 字符数超阈值
  // 时加按钮。准确行数依赖容器宽度, 这里用字符/换行粗估, 实际显示
  // 仍由 CSS -webkit-line-clamp 截到 2 行, 按钮可手动展开。
  const needsExpand =
    text.split('\n').length > PROMPT_EXPAND_LINE_THRESHOLD ||
    text.length > PROMPT_EXPAND_CHAR_THRESHOLD
  const clamped = !expanded && needsExpand

  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          fontSize: 11,
          color: 'rgba(255,255,255,0.45)',
          marginBottom: 4,
          letterSpacing: 0.5,
        }}
      >
        Prompt:
      </div>
      <div
        style={{
          fontSize: 13,
          color: '#fff',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          ...(clamped
            ? {
                display: '-webkit-box',
                WebkitLineClamp: PROMPT_EXPAND_LINE_THRESHOLD,
                WebkitBoxOrient: 'vertical' as const,
                overflow: 'hidden',
              }
            : {}),
        }}
      >
        {text}
      </div>
      {needsExpand && (
        <Button
          type="link"
          size="small"
          onClick={() => setExpanded((e) => !e)}
          style={{ padding: 0, marginTop: 2, fontSize: 11, height: 'auto' }}
        >
          {expanded ? '收起' : '展开'}
        </Button>
      )}
    </div>
  )
}

/** Bash 后台任务详情面板。仿 OpenCC Shell details 布局:
 *  Status · Runtime · Command · Output (stdout/stderr 合并展示). */
export function BashTaskView({
  task,
}: {
  task: BashTaskInfo
}) {
  const [expanded, setExpanded] = useState(false)
  const [killing, setKilling] = useState(false)
  const handleKill = async () => {
    if (killing || task.status !== 'running') return
    setKilling(true)
    try {
      await killBashTask(task.taskId)
      // 刷新详情
      const updated = await fetchBashTask(task.taskId)
      if (updated) onTaskChange?.(updated)
    } catch (err) {
      console.warn('[BashTaskView] kill failed:', err)
    } finally {
      setKilling(false)
    }
  }
  const runtimeMs = (task.finishedAt ?? Date.now()) - task.startedAt
  const runtimeStr = formatDuration(runtimeMs)
  const statusColor =
    task.status === 'completed' ? '#52c41a'
      : task.status === 'running' ? '#a78bfa'
        : '#f5222d'
  const output = task.stdout + (task.stderr ? `\n${task.stderr}` : '')
  const maxOutputLines = 20
  const outputLines = output.split('\n')
  const isLongOutput = outputLines.length > maxOutputLines
  const visibleLines = expanded ? outputLines : outputLines.slice(0, maxOutputLines)
  const statusMeta: Record<string, string> = {
    running: '运行中', completed: '完成', failed: '失败', killed: '已终止',
  }

  return (
    <div style={{ padding: '12px 20px' }}>
      {/* 状态行 */}
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <span style={{ color: statusColor, fontWeight: 500 }}>
            {task.status === 'running' ? '⏳ ' : task.status === 'completed' ? '✅ ' : '❌ '}
            {statusMeta[task.status] ?? task.status}
          </span>
          <span style={{ marginLeft: 12 }}>Runtime: {runtimeStr}</span>
          {task.exitCode !== undefined && (
            <span style={{ marginLeft: 12 }}>exit: {task.exitCode}</span>
          )}
        </div>
        {task.status === 'running' && (
          <Button
            danger
            size="small"
            loading={killing}
            onClick={handleKill}
            style={{ fontSize: 11 }}
          >
            {killing ? '终止中…' : '终止'}
          </Button>
        )}
      </div>
      {/* Command */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.40)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Command
        </div>
        <div
          style={{
            fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
            fontSize: 12,
            color: '#fff',
            background: 'rgba(255,255,255,0.05)',
            padding: '6px 10px',
            borderRadius: 4,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {task.command}
        </div>
      </div>
      {/* Output */}
      <div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.40)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', justifyContent: 'space-between' }}>
          <span>Output</span>
          {isLongOutput && !expanded && (
            <span style={{ color: 'rgba(255,255,255,0.35)', textTransform: 'none' }}>
              Showing {maxOutputLines} / {outputLines.length} lines · {Math.round(output.length / 1024 * 10) / 10}KB
            </span>
          )}
        </div>
        <pre
          style={{
            fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
            fontSize: 11,
            lineHeight: 1.5,
            color: 'rgba(255,255,255,0.85)',
            background: '#1a1a1a',
            padding: '8px 10px',
            borderRadius: 4,
            maxHeight: expanded ? 'none' : 360,
            overflow: 'auto',
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {visibleLines.join('\n') || '(空)'}
        </pre>
        {isLongOutput && (
          <Button
            type="link"
            size="small"
            onClick={() => setExpanded((e) => !e)}
            style={{ padding: 0, marginTop: 2, fontSize: 11, height: 'auto', color: '#a78bfa' }}
          >
            {expanded ? '收起' : `展开完整输出 (${outputLines.length} 行)`}
          </Button>
        )}
      </div>
    </div>
  )
}

const TOOL_STATUS_LABEL: Record<ToolCallEntry['status'], string> = {
  running: 'Running',
  done: 'Done',
  error: 'Error',
  invalid: 'Invalid',
  denied: 'Denied',
}

function compactInput(value: unknown): string {
  try {
    const serialized = JSON.stringify(value) ?? String(value)
    // JSON.stringify 会把字符串值内的真实空白(换行/制表/空格)转义为
    // `\n`/`\t`/`\r` 这类 JSON 转义序列,字面上只是两个普通字符 '\' 'n',
    // 因此 `\s+` 不会命中。仅靠 `\s+` 会让 `{value:"a\nb"}` 保持
    // `{"value":"a\nb"}` 字面,与单行压缩目标 `{"value":"a b"}` 不符。
    // 这里用 `/\\[ntr]|\s+/g`:对 JSON 转义的 `\n`/`\t`/`\r` 直接替换成空格,
    // 同时折叠其余真实空白;其它字面字符(包括 command/path 里的 n/t/r)
    // 不受影响。
    return serialized.replace(/\\[ntr]|\s+/g, ' ')
  } catch {
    return String(value).replace(/\s+/g, ' ')
  }
}

export function formatToolInput(name: string, input: unknown): string {
  if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim()
  if (!input || typeof input !== 'object' || Array.isArray(input)) return compactInput(input)

  const record = input as Record<string, unknown>
  const filePath =
    typeof record.file_path === 'string'
      ? record.file_path
      : typeof record.path === 'string'
        ? record.path
        : undefined
  if (filePath) return name.toLowerCase() === 'read' ? `@${filePath}` : `path=@${filePath}`

  if (typeof record.command === 'string') return `command=${record.command.replace(/\s+/g, ' ').trim()}`
  if (typeof record.query === 'string') return `query=${record.query.replace(/\s+/g, ' ').trim()}`

  return compactInput(record)
}

export function formatToolCallLine(
  entry: Pick<ToolCallEntry, 'name' | 'input' | 'status'>,
): string {
  return `${entry.name}: ${formatToolInput(entry.name, entry.input)} (${TOOL_STATUS_LABEL[entry.status]})`
}

export function ToolCallCard({ entry }: { entry: ToolCallEntry }) {
  // 单行布局:左侧工具名 + 输入摘要(可省略),右侧独立状态文字。
  // 状态颜色按用户确认: done=绿, running=黄, error/invalid/denied=红。
  // 左边框(状态指示条)与右侧状态文字共用同一 statusColor,保证语义一致。
  const statusColor =
    entry.status === 'done'
      ? '#52c41a'
      : entry.status === 'running'
        ? '#fadb14'
        : '#f5222d'
  const inputLine = `${entry.name}: ${formatToolInput(entry.name, entry.input)}`
  const fullLine = formatToolCallLine(entry)

  return (
    <div
      title={fullLine}
      style={{
        borderLeft: `3px solid ${statusColor}`,
        background: 'rgba(255,255,255,0.04)',
        padding: '8px 12px',
        borderRadius: 4,
        margin: '6px 0',
        fontSize: 12,
        fontFamily: 'ui-monospace, monospace',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
      }}
    >
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {inputLine}
      </span>
      <span style={{ marginLeft: 'auto', flexShrink: 0, color: statusColor }}>
        {TOOL_STATUS_LABEL[entry.status]}
      </span>
    </div>
  )
}

/**
 * 把事件流聚合成两类展示单元:
 * - 累积文本(text deltas)
 * - 工具调用(tool_use:start / done / error / invalid / denied)
 */
export function buildTimeline(events: StreamedEvent[]): Array<
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
          } else if (ev.type === 'tool_use:error') {
            existing.status = 'error'
          } else if (ev.type === 'tool_use:invalid') {
            existing.status = 'invalid'
          } else if (ev.type === 'tool_use:denied') {
            existing.status = 'denied'
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
  // detail / bashTask 100% 从 useAgentStore 读 — SSE agent_task.changed /
  // bash_task.changed 推送的 BackgroundTaskSummary.detail 已含完整 task。
  // 切 session 期间 store 里没当前 taskId 的 entry 时显示 "not found"。
  const allSessionIds = useAgentStore((s) => Object.keys(s.agentTasksBySession))
  const detail = useAgentStore((s) => {
    if (!taskId || taskId.startsWith('bash-')) return null
    for (const sid of Object.keys(s.agentTasksBySession)) {
      const summary = s.agentTasksBySession[sid]?.find((t) => t.taskId === taskId)
      if (summary?.detail) return summary.detail
    }
    return null
  })
  const bashTask = useAgentStore((s) => {
    if (!taskId || !taskId.startsWith('bash-')) return null
    for (const sid of Object.keys(s.bashTasksBySession)) {
      const t = s.bashTasksBySession[sid]?.find((task) => task.taskId === taskId)
      if (t) return t
    }
    return null
  })
  const [events, setEvents] = useState<StreamedEvent[]>([])
  const [loading, setLoading] = useState(false)
  const aborterRef = useRef<AbortController | null>(null)

  // 区分 agent task 与 bash task: taskId 以 "bash-" 开头为 bash.
  const isBashTask = !!taskId && taskId.startsWith('bash-')

  // taskId 变化时清 events;detail/bashTask 由上面 selector 实时算。
  useEffect(() => {
    if (!taskId) {
      setEvents([])
      return
    }
    setLoading(true)
    // SSE agent_task.changed / bash_task.changed 已保证 store 里有最新 task;
    // 200ms 后若 store 仍没 entry(detail/bashTask 都 null),显示 "not found"。
    // 这是 SSE 还没推到的窗口(冷启动),非真错误 — 见 useBackgroundTasks 设计。
    const t = setTimeout(() => setLoading(false), 200)
    return () => clearTimeout(t)
  }, [taskId])

  // 订阅 agent task event stream (bash task 没有自己的 event stream,
  // 完全靠 bash_task.changed SSE 推 detail 到 store;drawer 直接读 store 渲染)。
  // destroyOnClose 让每次打开 drawer 都是全新挂载、events 数组已 reset 为 [],
  // 所以这里**永远从 seq=0 开始**重放,避免误把 eventCount 当作 Last-Event-ID
  // 续读 — 那样会导致已完成任务的全部历史事件(seq 1..eventCount)从未到达前端,
  // 而后端只发 seq>eventCount 的尾包,UI 看起来像"事件: 0 / 等待事件..."。
  // 服务端在读完历史后对运行中任务会自动转 live tail,对已完成任务直接结束 SSE 流。
  useEffect(() => {
    if (!taskId || isBashTask) return
    const ac = new AbortController()
    aborterRef.current = ac
    let cancelled = false
    void (async () => {
      try {
        for await (const frame of subscribeTaskEvents(taskId, 0, ac.signal)) {
          if (cancelled) break
          handleFrame(frame)
        }
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return
        console.warn('[TaskDrawer] subscribe events failed:', err)
      }
    })()
    return () => {
      cancelled = true
      ac.abort()
      aborterRef.current = null
    }
  }, [taskId, isBashTask])

  function handleFrame(frame: SseFrame) {
    const wireData = frame.data as StreamedEvent['data'] & {
      seq?: number
      ts?: number
      type?: string
      eventId?: string
      data?: StreamedEvent['data']
    }
    // ★ 关键修复 (HRMSV3-ZN-WEBSITE#668):解开 server 端的 SSE 双层包裹。
    // routes/tasks.ts 的 evToWire 把 NDJSON 行的整个对象(含 type/data 等
    // metadata)放进了 JSON payload,导致 wire 是 wrapper {seq,type,eventId,data: <payload>}。
    // buildTimeline 之前在 wrapper 上找 toolUseId / delta.text 等 → 全部 undefined,
    // tool_use:start 直接被 `if (!toolUseId) break` 静默跳过,前端就只剩 system 类的
    // runtime.done 卡片,看起来"事件数有,但工具调用不显示"。
    //
    // task.ended 走的是另外的字段(status/resultText 直接在 wrapper 上),
    // 不需要再下钻到 .data,保留原形态。
    if (frame.event === 'task.ended') {
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              status: (wireData as { status?: string }).status as BackgroundTask['status'] ?? prev.status,
              resultText: (wireData as { resultText?: string }).resultText ?? prev.resultText,
              finishedAt: Date.now(),
            }
          : prev,
      )
      return
    }
    const innerPayload =
      wireData && typeof wireData === 'object' && 'data' in wireData && wireData.data && typeof wireData.data === 'object'
        ? (wireData.data as StreamedEvent['data'])
        : wireData
    const ts = innerPayload && typeof innerPayload === 'object' && 'ts' in innerPayload && typeof (innerPayload as { ts?: number }).ts === 'number'
      ? (innerPayload as { ts: number }).ts
      : (wireData as { ts?: number }).ts ?? Date.now()
    setEvents((prev) => [
      ...prev,
      {
        seq: frame.id,
        type: frame.event,
        ts,
        data: innerPayload,
      },
    ])
  }

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
          <span>{isBashTask ? 'Shell' : '后台 Agent'}</span>
          {detail && !isBashTask && (
            <Tag color={meta?.color} style={{ margin: 0 }}>
              {meta?.icon} {meta?.label}
            </Tag>
          )}
          {detail && !isBashTask && duration && (
            <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>{duration}</span>
          )}
          {bashTask && (
            <Tag
              color={
                bashTask.status === 'completed' ? '#52c41a'
                  : bashTask.status === 'running' ? '#a78bfa'
                    : '#f5222d'
              }
              style={{ margin: 0 }}
            >
              {bashTask.status === 'completed' ? '✅ 完成' : bashTask.status === 'running' ? '⏳ 运行中' : '❌ 失败'}
            </Tag>
          )}
          {bashTask && (
            <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>{formatDuration((bashTask.finishedAt ?? Date.now()) - bashTask.startedAt)}</span>
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
      {loading && !detail && !bashTask && (
        <div style={{ padding: 24, textAlign: 'center', color: 'rgba(255,255,255,0.45)' }}>
          <LoadingOutlined /> 加载中...
        </div>
      )}
      {bashTask && (
        <BashTaskView task={bashTask} onTaskChange={setBashTask} />
      )}
      {detail && !isBashTask && (
        <>
          {/* 头部信息 */}
          <div
            style={{
              padding: '12px 20px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              background: '#1a1a1a',
            }}
          >
            <PromptBlock text={detail.input.prompt} />
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
                        color: '#fff',
                        padding: '6px 0',
                      }}
                    >
                      <MarkdownText text={item.text} />
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