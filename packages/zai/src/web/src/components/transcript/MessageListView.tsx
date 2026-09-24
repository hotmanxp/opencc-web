import { Fragment, useMemo, type ReactElement } from 'react'
import { useAgentStoreOrCtx, type AgentMessage } from '../../store/useAgentStore.js'
import { MessageBubble } from './MessageBubble.js'
import { CollapsedMessageBubble } from './CollapsedMessageBubble.js'
import { ToolGroupCard } from './ToolGroupCard.js'
import { deriveTranscriptNodes, type ToolGroupEntry, type ToolGroupStatus } from './deriveTranscriptNodes.js'
import { lastAssistantTextIndex } from './deriveStreamLive.js'
import { getRenderer } from '../toolRenderers/registry.js'
import { deriveTurnArtifacts, type TurnArtifacts } from './deriveTurnArtifacts.js'
import { TurnArtifactsBlock } from './TurnArtifactsBlock.js'

// toolGroup 内的 status 是否需要保留 ToolGroupCard 外壳(展示状态提示)。
// pending/error/invalid/denied 都保留外壳。
const STATUS_KEEPS_SHELL: ReadonlySet<ToolGroupStatus> = new Set([
  'pending',
  'error',
  'invalid',
  'denied',
])

/** 同一 toolGroup 拆出来的渲染段:inline 直接内联,card 进 ToolGroupCard。 */
type GroupSegment =
  | { kind: 'inline'; entries: ToolGroupEntry[] }
  | { kind: 'card'; entries: ToolGroupEntry[] }

/**
 * 把 toolGroup 的条目按「是否自包含展示工具」切成保序段。
 *
 * 判定单条粒度(与旧 shouldSkipOuterGroup 同规则,但不再要求整组一致):
 * - renderer.skipOuterGroup === true 且 status === 'done' → inline
 * - 其余(含 pending/error/invalid/denied,以及未标标记的工具)→ card
 *
 * 这样「模型一轮里先 Read 再 PresentFile」不会因为组内有别的工具而把
 * 文件卡整组吞进折叠卡(2026-09-24 PresentFile 设计 §7)。
 */
function splitToolGroupEntries(entries: ToolGroupEntry[]): GroupSegment[] {
  const segs: GroupSegment[] = []
  for (const e of entries) {
    const name = (e.message as { name?: unknown }).name
    const selfContained =
      typeof name === 'string' &&
      name.length > 0 &&
      getRenderer(name).skipOuterGroup === true &&
      !STATUS_KEEPS_SHELL.has(e.status)
    const kind: GroupSegment['kind'] = selfContained ? 'inline' : 'card'
    const last = segs[segs.length - 1]
    if (last && last.kind === kind) last.entries.push(e)
    else segs.push({ kind, entries: [e] })
  }
  return segs
}

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
  const collapsed = useAgentStoreOrCtx((s) => s.transcriptCollapsed)
  const status = useAgentStoreOrCtx((s) => s.status)
  // filter 每次渲染都产生新数组 → 不 memo 的话下面两个 useMemo 会全量重算
  const visibleMessages = useMemo(
    () => messages.filter((m) => !isAgentToolMessage(m)),
    [messages],
  )
  // 每轮 → 该轮产物文件列表(纯派生,见 deriveTurnArtifacts)。产物块只在
  // 已结束的轮次出现:被下一轮顶掉的,或最后一轮且 status 不是 streaming。
  const turns = useMemo(
    () => deriveTurnArtifacts(visibleMessages, { status }),
    [visibleMessages, status],
  )
  // expanded 分支用:锚点下标 → 该轮产物(expanded 每条消息各占一项,
  // 轮的 endIndex 必然等于某条消息的下标,精确匹配即可)。
  // collapsed 分支不能这样查 —— 见下方 artifactsByNode 的说明。
  // (`as const` 让 map 回调产出 readonly tuple,匹配 Map 的 iterable 签名)
  const artifactsByAnchor = useMemo(
    () => new Map<number, TurnArtifacts>(turns.map((t) => [t.endIndex, t] as const)),
    [turns],
  )

  if (!collapsed) {
    // expanded: 逐条渲染,并在每一轮的最后一条消息之后插入「本轮产物」块。
    return (
      <>
        {visibleMessages.flatMap((msg, idx) => {
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
          const bubble = <MessageBubble key={reactKey} msg={msg} streaming={isLive} />
          const turn = artifactsByAnchor.get(idx)
          if (!turn) return [bubble]
          return [
            bubble,
            <TurnArtifactsBlock key={`art-${turn.turnKey}`} files={turn.files} />,
          ]
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

  // 「本轮产物」块在 collapsed 视图里的落点。
  //
  // 不能像 expanded 那样要求 node 末尾恰好等于轮的 endIndex: collapsed 的
  // text bucket 会跨轮合并 —— 上一轮收尾的 assistant.text 与下一轮开头的
  // user.text 同桶(deriveTranscriptNodes 只在工具边界 flush),于是轮的
  // endIndex 可能落在某个 node 的中间。
  //
  // 所以改成「挂到包含该轮最后一条消息的那个 node 上」,两者都按 index 有序,
  // 一次线性扫描即可。node 的覆盖区间由自身载荷推导(startIndex + 元素数 - 1),
  // **不读 node.endIndex**:尾部 text 节点有个既存 off-by-one(尾刷把
  // messages.length - 1 当 idx 传入,而 pushText 内部又减 1),会得到
  // endIndex = startIndex - 1。
  const artifactsByNode = new Map<number, TurnArtifacts[]>()
  if (turns.length > 0) {
    let ti = 0
    for (let i = 0; i < nodes.length && ti < turns.length; i++) {
      const node = nodes[i]!
      const nodeEnd = node.kind === 'text'
        ? node.startIndex + node.messages.length - 1
        : node.kind === 'toolGroup'
          ? node.startIndex + node.toolCalls.length - 1
          : node.index
      const bucket: TurnArtifacts[] = []
      while (ti < turns.length && turns[ti]!.endIndex <= nodeEnd) {
        bucket.push(turns[ti]!)
        ti++
      }
      if (bucket.length > 0) artifactsByNode.set(i, bucket)
    }
  }

  return (
    <>
      {nodes.flatMap((node, i) => {
        let el: ReactElement
        if (node.kind === 'toolGroup') {
          // 外层 Fragment 必须带 key —— 它在下面的 flatMap 里会被放进数组
          // ([el] 或 [el, ...产物块]),无 key 会触发 React 的列表 key 警告。
          el = (
            <Fragment
              key={`grp-${node.toolCalls[0]?.message.eventId ?? node.startIndex}`}
            >
              {splitToolGroupEntries(node.toolCalls).map((seg) => {
                // key 用段内首条 entry 的 eventId(而非下标区间):新消息 append
                // 不改变已有段的 key → 不重挂载,组卡折叠态与卡内展开态都不丢。
                const firstId =
                  ((seg.entries[0]?.message as any).eventId as string) ??
                  `seg-${seg.entries[0]?.index ?? 0}`
                if (seg.kind === 'inline') {
                  return (
                    <span key={`seg-inline-${firstId}`}>
                      {seg.entries.map((e) => {
                        const evtId = ((e.message as any).eventId as string) ?? `tool-${e.index}`
                        return (
                          <MessageBubble
                            key={evtId}
                            msg={e.message}
                            streaming={e.status === 'pending'}
                          />
                        )
                      })}
                    </span>
                  )
                }
                return <ToolGroupCard key={`seg-card-${firstId}`} entries={seg.entries} />
              })}
            </Fragment>
          )
        } else if (node.kind === 'thinking') {
          // 注意: collapsed 视图下, 流式 'assistant.thinking' 不会进这种
          // 节点 (deriveTranscriptNodes 只把 legacy 'assistant' + thinking
          // 字段提为 kind: 'thinking'). 流式 'assistant.thinking' 走
          // text bucket, 见下面的 isThinkingMsg 分支.
          // 这里是历史回放里的 legacy thinking 节点, 始终静态 (不闪烁).
          el = (
            <MessageBubble
              key={`think-${node.index}-${i}`}
              msg={node.message}
              streaming={false}
            />
          )
        } else if (node.kind === 'ask') {
          // AskUserQuestion must stay full-width; route through MessageBubble for parity.
          el = (
            <MessageBubble
              key={`ask-${node.index}-${i}`}
              msg={node.message}
              streaming={false}
            />
          )
        } else {
          // text node: render each contained message through CollapsedMessageBubble (single-msg view)
          // key 用首条消息的 eventId (而非此时的下标区间) 作为稳定标识: 新消息
          // append 到同一 text bucket 末尾时, 首条 eventId 不变, key 不变 →
          // 子树不重挂载, CollapsedMessageBubble / AssistantTextBody 内部展开态保留.
          el = (
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
        }
        const turnsHere = artifactsByNode.get(i)
        if (!turnsHere) return [el]
        return [
          el,
          ...turnsHere.map((t) => (
            <TurnArtifactsBlock key={`art-${t.turnKey}`} files={t.files} />
          )),
        ]
      })}
    </>
  )
}
