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
          // "正在被流式累积"的精确判定 — 不依赖 status (status === 'streaming'
          // 在 thinking_delta / text_delta 累积期间都是 true, 但语义上是
          // "正在被累积" 的 lastIndex message). 关键是:
          //   - lastIndex && type === 'assistant.thinking' → 正在 thinking_delta 累积
          //   - lastIndex && type === 'assistant.text' && streaming → 正在 text_delta 累积
          //   - 其他情况 (历史 / 已完成 / tool_use) → false
          // 不依赖 SSE 长连接 status, 也不依赖 zustand 全局 status 标志,
          // 只看 message 自身是不是 lastIndex + 类型, 避免 SSE 阻塞 / status
          // 错位导致动画不触发.
          const lastIdx = visibleMessages.length - 1
          const isLive = idx === lastIdx && (
            t === 'assistant.thinking' ||
            (t === 'assistant.text' && Boolean(streaming))
          )
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
          // Thinking 在 collapsed 视图下: 用 lastIndex 判定 (与 expanded 视图
          // 保持一致). 如果当前节点就是 messages 最后一条且 type === 'assistant.thinking',
          // 说明它正在被 thinking_delta 累积, 折叠态用户需要看到思考动画反馈.
          return (
            <MessageBubble
              key={`think-${node.index}-${i}`}
              msg={node.message}
              streaming={node.index === visibleMessages.length - 1}
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
