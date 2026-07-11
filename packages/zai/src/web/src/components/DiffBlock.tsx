import type { AgentMessage } from '../store/useAgentStore'
import { computeLineDiff, summarizeDiff, type DiffRow } from '../lib/diff'

const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

// diff 配色: 仿 GitHub 深色 diff — 新增绿、删除红, 半透明底叠在 #000 页面背景上.
const ADD_BG = 'rgba(46,160,67,0.18)'
const ADD_FG = '#3fb950'
const DEL_BG = 'rgba(248,81,73,0.18)'
const DEL_FG = '#f85149'
const CTX_FG = 'rgba(255,255,255,0.72)'
const GUTTER_FG = 'rgba(255,255,255,0.30)'

type ToolStatus = 'start' | 'done' | 'error'

// 头部状态圆点: 调用中橙 / 完成绿 / 出错红. 与 ToolCallBlock 的语义一致.
const DOT_COLOR: Record<ToolStatus, string> = {
  start: '#ff6600',
  done: '#3fb950',
  error: '#f85149',
}

function statusOf(type: string): ToolStatus {
  if (type === 'tool_use:done') return 'done'
  if (type === 'tool_use:error' || type === 'tool_use:invalid' || type === 'tool_use:denied') {
    return 'error'
  }
  return 'start'
}

function DiffRowLine({ row }: { row: DiffRow }) {
  const bg = row.kind === 'add' ? ADD_BG : row.kind === 'del' ? DEL_BG : 'transparent'
  const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
  const markerColor = row.kind === 'add' ? ADD_FG : row.kind === 'del' ? DEL_FG : GUTTER_FG
  const textColor = row.kind === 'context' ? CTX_FG : row.kind === 'add' ? ADD_FG : DEL_FG
  return (
    <div style={{ display: 'flex', background: bg, minWidth: 'max-content' }}>
      <span
        style={{
          flexShrink: 0,
          width: 44,
          textAlign: 'right',
          paddingRight: 10,
          color: GUTTER_FG,
          userSelect: 'none',
        }}
      >
        {row.no}
      </span>
      <span style={{ flexShrink: 0, width: 16, color: markerColor, userSelect: 'none' }}>
        {marker}
      </span>
      <span style={{ color: textColor, whiteSpace: 'pre', paddingRight: 12 }}>
        {row.text || ' '}
      </span>
    </div>
  )
}

// Edit / Write 工具的代码变更展示块.
// - Edit: 对 old_string ↔ new_string 做行级 diff, 行号片段内 1 起.
// - Write: 整篇 content 当新增行 (前端无旧内容).
// 常驻展开 + maxHeight 滚动, 不折叠.
export default function DiffBlock({ msg }: { msg: AgentMessage }) {
  const name = (msg.name as string) || 'Edit'
  const input = (msg.input as Record<string, unknown>) || {}
  const type = msg.type as string
  const status = statusOf(type)

  const filePath = (input.file_path as string) || ''
  const isWrite = name === 'Write'
  const oldString = isWrite ? '' : (input.old_string as string) || ''
  const newString = isWrite ? (input.content as string) || '' : (input.new_string as string) || ''

  const rows = computeLineDiff(oldString, newString)
  const { added, removed } = summarizeDiff(rows)

  // 摘要: 只增 / 只删 / 增删都有.
  let summary = ''
  if (added && removed) summary = `+${added} −${removed}`
  else if (added) summary = `Added ${added} line${added > 1 ? 's' : ''}`
  else if (removed) summary = `Removed ${removed} line${removed > 1 ? 's' : ''}`

  const errorField = msg.error as string | { message?: string } | undefined
  const reasonField = msg.reason as string | undefined
  const errorText =
    typeof errorField === 'string' ? errorField : errorField?.message || reasonField || ''

  const headerLabel = isWrite ? 'Write' : 'Update'

  return (
    <div style={{ marginBottom: 8, maxWidth: '100%' }}>
      {/* 头部: 状态点 + Update/Write(path) + 摘要 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: MONO,
          fontSize: 13,
          marginBottom: 4,
          minWidth: 0,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: DOT_COLOR[status],
            flexShrink: 0,
          }}
        />
        <span style={{ color: 'rgba(255,255,255,0.9)', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {headerLabel}(<span style={{ color: 'rgba(255,255,255,0.6)', fontWeight: 400 }}>{filePath}</span>)
        </span>
        {summary && (
          <span style={{ color: GUTTER_FG, flexShrink: 0 }}>{summary}</span>
        )}
      </div>

      {/* diff 主体: 横向可滚动 (长行), 纵向 maxHeight 限高滚动 */}
      {rows.length > 0 && (
        <div
          style={{
            fontFamily: MONO,
            fontSize: 12,
            lineHeight: 1.55,
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6,
            padding: '6px 0',
            maxHeight: 360,
            overflow: 'auto',
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          {rows.map((row, idx) => (
            <DiffRowLine key={idx} row={row} />
          ))}
        </div>
      )}

      {errorText && (
        <pre
          style={{
            fontSize: 12,
            margin: '6px 0 0 0',
            padding: '8px 10px',
            background: 'rgba(255,77,79,0.06)',
            borderLeft: '2px solid #ff4d4f',
            borderRadius: 4,
            color: '#f85149',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: MONO,
          }}
        >
          {errorText}
        </pre>
      )}
    </div>
  )
}
