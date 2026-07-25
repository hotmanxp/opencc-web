import { useState } from 'react'
import { Button, Card, Tag } from 'antd'
import type { ToolGroupEntry } from './deriveTranscriptNodes.js'
import { MessageBubble } from './MessageBubble.js'

function summarizeNames(entries: ToolGroupEntry[]): string {
  // 工具名取 msg.name (与 MessageBubble.ToolCallBlock 一致), 不要取 toolName
  // (那是 transcript 历史回放字段, 当前 zai store 里没填). 空名条目静默跳过,
  // 让"工具调用中..."过渡态显示时不带杂项 fallback "Tool".
  const names = entries
    .map((e) => ((e.message as any).name as string | undefined)?.trim())
    .filter((n): n is string => Boolean(n))
  // Dedup consecutive duplicates: "Bash, Bash, Read" → "Bash, Read +1"
  const seen: string[] = []
  for (const n of names) if (seen[seen.length - 1] !== n) seen.push(n)
  if (seen.length <= 3) return seen.join(', ')
  return `${seen.slice(0, 3).join(', ')} +${seen.length - 3}`
}

function errorCount(entries: ToolGroupEntry[]): number {
  return entries.filter((e) => e.status === 'error' || e.status === 'invalid' || e.status === 'denied').length
}

export function ToolGroupCard({ entries }: { entries: ToolGroupEntry[] }) {
  const [expanded, setExpanded] = useState(false)
  const errs = errorCount(entries)
  const summary = summarizeNames(entries)
  const titleText = entries.length === 1
    ? (summary ? `1 个工具调用 · ${summary}` : '1 个工具调用')
    : `${entries.length} 个工具调用`

  return (
    // 工具折叠卡片宽度与 LLM 文字气泡一致 (maxWidth:100%), 用深色半透明
    // 面板 + 紫色左边条与浅绿 (#f6ffed) 文字气泡视觉区分: 文字气泡表达
    // "模型回复", 工具面板表达 "工具调用汇总", 颜色互不抢占.
    <Card
      size="small"
      style={{
        marginBottom: 8,
        // 减去与 LLM 气泡相同的 marginRight(20), 让卡片实际渲染宽度
        // 与 #f6ffed 文字气泡一致, 而不是被 100% + 20px marginRight
        // 撑得比文字气泡长一截.
        width: 'calc(100% - 20px)',
        maxWidth: 'calc(100% - 20px)',
        marginRight: 20,
        // 与 LLM 文字气泡 (#f6ffed 浅绿) 形成稳定对比:
        // 工具面板用紫色半透明底 + 紫色左边条, 表达"工具调用汇总".
        // 透明度从 0.04 提到 0.10, 让面板在深色页面背景上清晰可见.
        background: 'rgba(114,45,209,0.10)',
        borderColor: 'rgba(114,45,209,0.45)',
        borderLeft: '3px solid #722ed1',
        borderRadius: 12,
      }}
      styles={{ body: { padding: 12 } }}
      title={
        <span style={{ fontSize: 13 }}>
          {titleText}
          {summary && entries.length > 1 && (
            <span style={{ marginLeft: 8, color: 'rgba(255,255,255,0.55)' }}>
              · {summary}
            </span>
          )}
          {errs > 0 && (
            <Tag color="red" style={{ marginLeft: 8 }}>{errs} 个失败</Tag>
          )}
        </span>
      }
      extra={
        <Button size="small" onClick={() => setExpanded((x) => !x)}>
          {expanded ? '收起' : `展开 ${entries.length} 个工具`}
        </Button>
      }
    >
      {expanded &&
        entries.map((e, i) => {
          const evtId = ((e.message as any).eventId as string) ?? `tool-${e.index}`
          return (
            <MessageBubble
              key={evtId}
              msg={e.message}
              streaming={e.status === 'pending'}
            />
          )
        })}
      {!expanded && (
        <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>
          {entries.some((e) => e.status === 'pending') ? '工具调用中…' : '折叠显示'}
        </div>
      )}
    </Card>
  )
}
