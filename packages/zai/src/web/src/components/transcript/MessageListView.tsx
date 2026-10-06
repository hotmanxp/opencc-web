import { Fragment, useMemo, type ReactElement } from 'react'
import { useAgentStoreOrCtx, type AgentMessage } from '../../store/useAgentStore.js'
import { MessageBubble } from './MessageBubble.js'
import { ToolRunGroup } from './ToolRunGroup.js'
import { deriveTranscriptNodes, type GroupItem, type ToolGroupStatus } from './deriveTranscriptNodes.js'
import { getRenderer } from '../toolRenderers/registry.js'
import { deriveTurnArtifacts, type TurnArtifacts } from './deriveTurnArtifacts.js'
import { TurnArtifactsBlock } from './TurnArtifactsBlock.js'

/** 组内一项的 React key: eventId 优先, 退回「类型-下标」。 */
function itemKey(it: GroupItem): string {
  return ((it.message as { eventId?: unknown }).eventId as string) ?? `${it.kind}-${it.index}`
}

function firstItemId(items: GroupItem[]): string | undefined {
  const first = items[0]
  return first === undefined ? undefined : itemKey(first)
}

// toolGroup 内的 status 是否需要保留「工具运行段」外壳。
// pending/error/invalid/denied 都保留外壳。
const STATUS_KEEPS_SHELL: ReadonlySet<ToolGroupStatus> = new Set([
  'pending',
  'error',
  'invalid',
  'denied',
])

/** 同一 toolGroup 拆出来的渲染段:inline 直接内联,run 进 ToolRunGroup。 */
type GroupSegment =
  | { kind: 'inline'; items: GroupItem[] }
  | { kind: 'run'; items: GroupItem[] }

/**
 * 把 toolGroup 的条目按「是否自包含展示工具」切成保序段。
 *
 * 判定单条粒度(与旧 shouldSkipOuterGroup 同规则,但不再要求整组一致):
 * - renderer.skipOuterGroup === true 且 status === 'done' → inline
 * - 其余(含 pending/error/invalid/denied,以及未标标记的工具)→ run
 *
 * 这样「模型一轮里先 Read 再 PresentFile」不会因为组内有别的工具而把
 * 文件卡整组吞进运行段(2026-09-24 PresentFile 设计 §7)。
 *
 * 思考项不参与切段: 它归入当前打开的那一段, 没有打开的段才自己起一段。
 * 段内首项是思考(理论上不会发生, 组由工具开启)时走 inline, 仍按原序渲染。
 */
function splitToolGroupItems(items: GroupItem[]): GroupSegment[] {
  const segs: GroupSegment[] = []
  for (const item of items) {
    const last = segs[segs.length - 1]
    if (item.kind === 'thinking') {
      if (last) last.items.push(item)
      else segs.push({ kind: 'inline', items: [item] })
      continue
    }
    const name = (item.message as { name?: unknown }).name
    const selfContained =
      typeof name === 'string' &&
      name.length > 0 &&
      getRenderer(name).skipOuterGroup === true &&
      !STATUS_KEEPS_SHELL.has(item.status)
    const kind: 'inline' | 'run' = selfContained ? 'inline' : 'run'
    if (last && last.kind === kind) last.items.push(item)
    else segs.push({ kind, items: [item] })
  }
  return segs
}

interface Props {
  messages: AgentMessage[]
  streaming?: boolean
}

// Agent 工具调用不在主 transcript 内联展示 —— 子代理的执行改由后台任务 dock
// 呈现 (服务端 agentTaskBridge 把 LocalAgentTask 状态推成 agent_task.changed)。
// 这里在渲染入口统一过滤。
function isAgentToolMessage(m: AgentMessage): boolean {
  const name = (m as { name?: unknown }).name ?? (m as { toolName?: unknown }).toolName
  return name === 'Agent'
}

export function MessageListView({ messages, streaming }: Props) {
  // transcriptCollapsed 现在的语义是「工具运行段全程折叠」: 关闭时(默认)
  // 运行中的段会自动展开成明细行, 跑完的段收成一行摘要; 打开时
  // (outputStyle === 'compact' 或右侧分屏锁定) 连运行中的段也不展开,
  // 优先把纵向空间让给对话正文。
  const transcriptCollapsed = useAgentStoreOrCtx((s) => s.transcriptCollapsed)
  const status = useAgentStoreOrCtx((s) => s.status)
  // filter 每次渲染都产生新数组 → 不 memo 的话下面几个 useMemo 会全量重算
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

  let nodes
  try {
    nodes = deriveTranscriptNodes(visibleMessages)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('deriveTranscriptNodes failed; falling back to flat list', err)
    return (
      <>
        {visibleMessages.map((msg, idx) => (
          <MessageBubble key={(msg as any).eventId || String(idx)} msg={msg} streaming={false} />
        ))}
      </>
    )
  }

  // 「本轮产物」块挂在包含该轮最后一条消息的那个 node 上。node 的覆盖区间
  // 由自身载荷推导(startIndex + 元素数 - 1), **不读 node.endIndex**:尾部
  // text 节点有个既存 off-by-one(尾刷把 messages.length - 1 当 idx 传入,
  // 而 pushText 内部又减 1),会得到 endIndex = startIndex - 1。
  const artifactsByNode = new Map<number, TurnArtifacts[]>()
  if (turns.length > 0) {
    let ti = 0
    for (let i = 0; i < nodes.length && ti < turns.length; i++) {
      const node = nodes[i]!
      const nodeEnd = node.kind === 'text'
        ? node.startIndex + node.messages.length - 1
        : node.kind === 'toolGroup'
          ? node.startIndex + node.items.length - 1
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
              key={`grp-${firstItemId(node.items) ?? node.startIndex}`}
            >
              {splitToolGroupItems(node.items).map((seg) => {
                // key 用段内首项的 eventId(而非下标区间):新消息 append
                // 不改变已有段的 key → 不重挂载,运行段的展开态不丢。
                const segKey = firstItemId(seg.items) ?? `seg-${seg.items[0]?.index ?? 0}`
                if (seg.kind === 'inline') {
                  return (
                    <span key={`seg-inline-${segKey}`}>
                      {seg.items.map((it) => (
                        <MessageBubble
                          key={itemKey(it)}
                          msg={it.message}
                          streaming={
                            it.kind === 'tool'
                              ? it.status === 'pending'
                              : it.index === visibleMessages.length - 1
                          }
                        />
                      ))}
                    </span>
                  )
                }
                // 段末的思考是最后一条消息时视为正在流式输出 —— 该段要跟着
                // 自动展开, 否则「模型还在想」被折叠起来看不见。
                const lastItem = seg.items[seg.items.length - 1]
                const streamingThinking =
                  lastItem !== undefined &&
                  lastItem.kind === 'thinking' &&
                  lastItem.index === visibleMessages.length - 1
                return (
                  <ToolRunGroup
                    key={`seg-run-${segKey}`}
                    items={seg.items}
                    autoExpandRunning={!transcriptCollapsed}
                    streamingThinking={streamingThinking}
                  />
                )
              })}
            </Fragment>
          )
        } else if (node.kind === 'thinking') {
          // 没被工具段包住的思考(轮首思考 / 纯问答轮)。思考是边流边追加的,
          // 所以「是不是最后一条」就是它的 live 信号, 不看 streaming prop。
          el = (
            <MessageBubble
              key={`think-${node.index}-${i}`}
              msg={node.message}
              streaming={node.index === visibleMessages.length - 1}
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
          // text node: 每条消息各走 MessageBubble (assistant.text 扁平散文 /
          // user.text 右对齐气泡 / 未知类型兜底), 不再拆成两套渲染器。
          // key 用每条自己的 eventId:新消息 append 不改已有 key → 不重挂载。
          el = (
            <Fragment key={`txt-${node.messages[0]?.eventId ?? node.startIndex}`}>
              {node.messages.map((m, mi) => {
                const evtId = ((m as any).eventId as string) ?? `txt-${node.startIndex}-${mi}`
                const msgIdx = node.startIndex + mi
                // 思考消息不再进 text 桶(derive 已把它摘走并入工具段), 这里
                // 只有正文/用户气泡 —— 末尾那条才是流式中的那条。
                const itemStreaming = streaming && msgIdx === visibleMessages.length - 1
                return (
                  <MessageBubble key={evtId} msg={m} streaming={itemStreaming} />
                )
              })}
            </Fragment>
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