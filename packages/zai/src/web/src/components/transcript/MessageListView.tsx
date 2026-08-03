import { useAgentStore, type AgentMessage } from '../../store/useAgentStore.js'
import { MessageBubble } from './MessageBubble.js'
import { CollapsedMessageBubble } from './CollapsedMessageBubble.js'
import { ToolGroupCard } from './ToolGroupCard.js'
import { deriveTranscriptNodes } from './deriveTranscriptNodes.js'

interface Props {
  messages: AgentMessage[]
  streaming?: boolean
}

// Agent 工具调用不在主 transcript 内联展示 —— 子代理的执行改由后台任务 dock
// 呈现 (服务端 agentTaskBridge 把 LocalAgentTask 状态推成 agent_task.changed)。
// 这里在渲染入口统一过滤,expanded (直接 map) 与 collapsed (deriveTranscriptNodes)
// 两条路径都覆盖。
function isAgentToolMessage(m: AgentMessage): boolean {
  const name = (m as { name?: unknown }).name ?? (m as { toolName?: unknown }).toolName
  return name === 'Agent'
}

export function MessageListView({ messages, streaming }: Props) {
  // 单一布尔字段,初值由 Layout hydrate 时根据 settings.outputStyle 设置:
  //   - outputStyle === 'compact' → transcriptCollapsed = true (默认收起)
  //   - 其余                     → transcriptCollapsed = false (默认展开)
  // 用户点工具栏按钮 → setTranscriptCollapsed(!transcriptCollapsed) 直接翻转;
  // 刷新回到 settings.outputStyle 决定的值.
  const collapsed = useAgentStore((s) => s.transcriptCollapsed)
  const visibleMessages = messages.filter((m) => !isAgentToolMessage(m))

  if (!collapsed) {
    // expanded: byte-identical to the original Agent.tsx map.
    return (
      <>
        {visibleMessages.map((msg, idx) => {
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
              streaming={streaming && idx === visibleMessages.length - 1}
            />
          )
        })}
      </>
    )
  }

  // collapsed: derive nodes, fall back to expanded on any derive error.
  let nodes
  try {
    nodes = deriveTranscriptNodes(visibleMessages)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('deriveTranscriptNodes failed; falling back to expanded view', err)
    return (
      <>
        {visibleMessages.map((msg, idx) => (
          <MessageBubble key={(msg as any).eventId || String(idx)} msg={msg} streaming={false} />
        ))}
      </>
    )
  }

  // 在 collapsed 视图下, 找到 messages 里最后一条 assistant.text 的索引;
  // 渲染时给对应气泡传 forceExpanded, 完整展开 (绕开 6 行 clamp). 分屏模式
  // (transcriptCollapsed=true) 用户期望看到 AI 的最近一条完整回答, 历史
  // 仍然 clamp — 这条规则与 splitPaneOpen 无关 (transcriptCollapsed 已经是
  // 单一真源, useSplitPaneCompactLock 把它锁到 true).
  const lastAssistantIdx = (() => {
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if ((visibleMessages[i] as { type?: string }).type === 'assistant.text') return i
    }
    return -1
  })()

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
              streaming={streaming && node.index === visibleMessages.length - 1}
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
              const msgIdx = node.startIndex + mi
              // "最后一条 assistant.text" 完整展开 (绕开 clamp);
              // 历史 assistant.text 仍走默认 6 行 clamp + "显示更多" 按钮.
              const isLastAssistant = msgIdx === lastAssistantIdx
              return (
                <CollapsedMessageBubble
                  key={evtId}
                  message={m}
                  streaming={streaming && node.endIndex === visibleMessages.length - 1}
                  forceExpanded={isLastAssistant}
                />
              )
            })}
          </div>
        )
      })}
    </>
  )
}
