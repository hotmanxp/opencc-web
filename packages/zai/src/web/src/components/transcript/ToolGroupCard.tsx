import { useState } from 'react'
import { Button, Card, Tag } from 'antd'
import type { ToolGroupEntry } from './deriveTranscriptNodes.js'
import { MessageBubble } from './MessageBubble.js'

function summarizeNames(entries: ToolGroupEntry[]): string {
  const names = entries
    .map((e) => ((e.message as any).toolName as string) ?? 'Tool')
    .filter(Boolean)
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
    ? `1 个工具调用 · ${summary}`
    : `${entries.length} 个工具调用`

  return (
    <Card
      size="small"
      style={{ marginBottom: 8 }}
      title={
        <span>
          {titleText}
          {summary && entries.length > 1 && (
            <span style={{ marginLeft: 8, color: '#8c8c8c' }}>· {summary}</span>
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
        <div style={{ color: '#8c8c8c', fontSize: 12 }}>
          {entries.some((e) => e.status === 'pending') ? '工具调用中…' : '折叠显示'}
        </div>
      )}
    </Card>
  )
}
