import { useMemo } from 'react'
import { useAgentStore, type AgentMessage } from '../../store/useAgentStore.js'
import { MessageBubble } from './MessageBubble.js'
import { CollapsedMessageBubble } from './CollapsedMessageBubble.js'
import { ToolGroupCard } from './ToolGroupCard.js'
import { deriveTranscriptNodes } from './deriveTranscriptNodes.js'

interface Props {
  messages: AgentMessage[]
  streaming?: boolean
}

export function MessageListView({ messages, streaming }: Props) {
  const collapsed = useAgentStore((s) => s.transcriptCollapsed)

  if (!collapsed) {
    // expanded: byte-identical to the original Agent.tsx map.
    return (
      <>
        {messages.map((msg, idx) => {
          const t = msg.type as string
          const toolUseId = t.startsWith('tool_use:')
            ? (msg as any).toolUseId
            : undefined
          const reactKey =
            (toolUseId ? `tool-${toolUseId}` : (msg as any).eventId) || String(idx)
          return (
            <MessageBubble
              key={reactKey}
              msg={msg}
              streaming={streaming && idx === messages.length - 1}
            />
          )
        })}
      </>
    )
  }

  // collapsed: derive nodes, fall back to expanded on any derive error.
  let nodes
  try {
    nodes = deriveTranscriptNodes(messages)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('deriveTranscriptNodes failed; falling back to expanded view', err)
    return (
      <>
        {messages.map((msg, idx) => (
          <MessageBubble key={(msg as any).eventId || String(idx)} msg={msg} streaming={false} />
        ))}
      </>
    )
  }

  return (
    <>
      {nodes.map((node, i) => {
        if (node.kind === 'toolGroup') {
          // group key spans its indices so streaming updates don't churn keys
          return (
            <ToolGroupCard
              key={`grp-${node.startIndex}-${node.endIndex}-${i}`}
              entries={node.toolCalls}
            />
          )
        }
        if (node.kind === 'thinking') {
          // Thinking in collapsed view: 与 expanded 走同一个 MessageBubble 渲染分支,
          // 让 ThinkingBlock (含 pill + 折叠 + 预览) 在两种视图下完全一致.
          // 原因: 早期 CollapsedMessageBubble 自渲染 thinking 文本, 用户反馈"思考模块不见了";
          // 根因是旧分支只匹配 type==='assistant', 而真正的思考消息 type 是 'assistant.thinking'.
          return (
            <MessageBubble
              key={`think-${node.index}-${i}`}
              msg={node.message}
              streaming={streaming && node.index === messages.length - 1}
            />
          )
        }
        if (node.kind === 'ask') {
          // AskUserQuestion must stay full-width; route through MessageBubble for parity.
          return (
            <MessageBubble
              key={`ask-${node.index}-${i}`}
              msg={node.message}
              streaming={false}
            />
          )
        }
        // text node: render each contained message through CollapsedMessageBubble (single-msg view)
        return (
          <div key={`txt-${node.startIndex}-${node.endIndex}-${i}`}>
            {node.messages.map((m, mi) => {
              const evtId = ((m as any).eventId as string) ?? `txt-${node.startIndex}-${mi}`
              return (
                <CollapsedMessageBubble
                  key={evtId}
                  message={m}
                  streaming={streaming && node.endIndex === messages.length - 1}
                />
              )
            })}
          </div>
        )
      })}
    </>
  )
}
