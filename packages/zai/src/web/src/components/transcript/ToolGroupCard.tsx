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
    // 工具折叠卡片宽度与 LLM 文字气泡一致 (maxWidth:100%), 用主题橙
    // 半透明面板 + 主题橙左边条与 LLM 文字气泡视觉区分: 文字气泡表达
    // "模型回复", 工具面板表达 "工具调用汇总". 颜色与全局 accent 统一,
    // 不再抢占 LLM 文字气泡的浅绿 (#f6ffed) 视觉.
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
        // 工具面板用半透明底 + 紫色左边条, 表达"工具调用汇总".
        // 透明度从 0.04 提到 0.08, 让面板在深色页面背景上清晰可见.
        // dark 主题用降饱和紫 (#8b5cf6), light 主题覆盖成主题橙.
        background: 'var(--tool-group-bg, rgba(139,92,246,0.08))',
        borderColor: 'var(--tool-group-border, rgba(139,92,246,0.40))',
        borderLeft: '3px solid var(--thinking-accent, #8b5cf6)',
        borderRadius: 12,
      }}
      styles={{
        // 头部背景: 与卡片体同色系深浅层次.
        // ⚠ AntD Card styles 槽位叫 header 不是 head (semantic-dom 命名),
        // 用 head 会被静默忽略.
        header: { background: 'var(--tool-group-header-bg, rgba(139,92,246,0.18))' },
        body: { padding: 12 },
      }}
      title={
        <span style={{ fontSize: 13 }}>
          {titleText}
          {summary && entries.length > 1 && (
            <span style={{ marginLeft: 8, color: 'var(--text-dim-55)' }}>
              · {summary}
            </span>
          )}
          {errs > 0 && (
            <Tag color="red" style={{ marginLeft: 8 }}>{errs} 个失败</Tag>
          )}
        </span>
      }
      extra={
        <Button
          size="small"
          type="text"
          onClick={() => setExpanded((x) => !x)}
        >
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
        <div style={{ color: 'var(--text-dim-55)', fontSize: 12 }}>
          {entries.some((e) => e.status === 'pending') ? '工具调用中…' : '折叠显示'}
        </div>
      )}
    </Card>
  )
}
