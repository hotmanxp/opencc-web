import { Typography } from 'antd'
import type { AgentMessage } from '../../store/useAgentStore.js'

const { Paragraph } = Typography

const CLAMP_LINES = 6

export function CollapsedMessageBubble({ message }: { message: AgentMessage }) {
  const m = message as any
  const text: string =
    (m.text as string) ?? (m.content as string) ?? ''

  // tool_use:error is a non-text message — render a red stripe, full text.
  const isError = (m.type as string) === 'tool_use:error'
  if (isError) {
    return (
      <div data-collapsed-error style={{ color: '#cf1322', padding: '4px 8px', borderLeft: '3px solid #cf1322' }}>
        <strong>Tool error</strong>
        <Paragraph style={{ marginBottom: 0, color: '#cf1322' }}>{text || '(no message)'}</Paragraph>
      </div>
    )
  }

  // Thinking: even in collapsed view, render full text.
  if ((m.type as string) === 'assistant' && typeof m.thinking === 'string' && m.thinking.length > 0) {
    return (
      <div style={{ padding: '4px 8px', background: '#fafafa', borderLeft: '3px solid #d9d9d9' }}>
        <em style={{ color: '#8c8c8c' }}>thinking:</em>
        <Paragraph style={{ marginBottom: 0 }}>{m.thinking as string}</Paragraph>
      </div>
    )
  }

  return (
    <div style={{ padding: '4px 8px' }}>
      <Paragraph
        ellipsis={{ rows: CLAMP_LINES, expandable: true, symbol: '显示更多' }}
        style={{ marginBottom: 0 }}
      >
        {text}
      </Paragraph>
    </div>
  )
}
