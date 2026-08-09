import { useAgentStore, type AgentMessage } from '../../store/useAgentStore.js'
import { MessageBubble } from './MessageBubble.js'
import { CollapsedMessageBubble } from './CollapsedMessageBubble.js'
import { ToolGroupCard } from './ToolGroupCard.js'
import { deriveTranscriptNodes } from './deriveTranscriptNodes.js'
import { lastAssistantTextIndex } from './deriveStreamLive.js'

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
          // 判定: "最后一条消息是 thinking" 即视为流式 thinking 累积中,
          // 给 ThinkingBlock 传 streaming={true} 启动动画. 旧实现这里
          // 用 idx === lastIdx 也能覆盖大多数场景; text 一切到, lastIdx
          // 立刻变成 text → thinking 自动失活 → 动画停. 简单可靠.
          const lastIdx = visibleMessages.length - 1
          const isLive =
            t === 'assistant.thinking'
              ? idx === lastIdx
              : t === 'assistant.text' && Boolean(streaming) && idx === lastIdx
          return (
            <MessageBubble
              key={reactKey}
              msg={msg}
              streaming={isLive}
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
  const lastAssistantIdx = lastAssistantTextIndex(visibleMessages)

  return (
    <>
      {nodes.map((node, i) => {
        if (node.kind === 'toolGroup') {
          // 用首条 tool entry 的 eventId 作稳定 key, 而非下标区间. 否则新消息
          // (或同一 turn 追加的新工具) 会改变 group 的 endIndex → key 变化 →
          // 整棵子树卸载重挂载, ToolGroupCard 内部折叠态被重置.
          return (
            <ToolGroupCard
              key={`grp-${node.toolCalls[0]?.message.eventId ?? node.startIndex}`}
              entries={node.toolCalls}
            />
          )
        }
        if (node.kind === 'thinking') {
          // 注意: collapsed 视图下, 流式 'assistant.thinking' 不会进这种
          // 节点 (deriveTranscriptNodes 只把 legacy 'assistant' + thinking
          // 字段提为 kind: 'thinking'). 流式 'assistant.thinking' 走
          // text bucket, 见下面的 isThinkingMsg 分支.
          // 这里是历史回放里的 legacy thinking 节点, 始终静态 (不闪烁).
          return (
            <MessageBubble
              key={`think-${node.index}-${i}`}
              msg={node.message}
              streaming={false}
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
        // key 用首条消息的 eventId (而非此时的下标区间) 作为稳定标识: 新消息
        // append 到同一 text bucket 末尾时, 首条 eventId 不变, key 不变 →
        // 子树不重挂载, CollapsedMessageBubble / AssistantTextBody 内部展开态保留.
        return (
          <div key={`txt-${node.messages[0]?.eventId ?? node.startIndex}`}>
            {node.messages.map((m, mi) => {
              const evtId = ((m as any).eventId as string) ?? `txt-${node.startIndex}-${mi}`
              const msgIdx = node.startIndex + mi
              // "最后一条 assistant.text" 完整展开 (绕开 clamp);
              // 历史 assistant.text 仍走默认 6 行 clamp + "显示更多" 按钮.
              const isLastAssistant = msgIdx === lastAssistantIdx
              // 判定: 最后一条消息是 thinking → 走 streaming=true; 否则
              // 走 status-based streaming (text 累积光标等).
              // assistant.thinking 在 collapsed 视图走 text bucket;
              // 简单规则: "thinking 是最后一条 messages" 即可.
              const mt = (m as { type?: string }).type
              const isThinkingMsg = mt === 'assistant.thinking'
              const lastOverallIdx = visibleMessages.length - 1
              const itemStreaming = isThinkingMsg
                ? msgIdx === lastOverallIdx
                : streaming && node.endIndex === lastOverallIdx
              return (
                <CollapsedMessageBubble
                  key={evtId}
                  message={m}
                  streaming={itemStreaming}
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
