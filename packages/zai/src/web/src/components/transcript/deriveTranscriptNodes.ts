import type { AgentMessage } from '../../store/useAgentStore.js'

export type ToolGroupStatus = 'pending' | 'done' | 'error' | 'invalid' | 'denied'

export type ToolGroupEntry = {
  message: AgentMessage
  index: number
  status: ToolGroupStatus
}

/**
 * 工具运行段里的一项。工具调用与夹在中间的思考按真实先后顺序共存,
 * 于是「思考 → 命令 → 思考 → 命令」渲染成一段而不是四段。
 *
 * 工具项就是 ToolGroupEntry 加一个 `kind` 判别位 —— 两类项都直接带
 * `message` / `index`, 下游不必为思考单开一套字段访问。
 */
export type GroupItem =
  | ({ kind: 'tool' } & ToolGroupEntry)
  | { kind: 'thinking'; message: AgentMessage; index: number }

export type TranscriptNode =
  | { kind: 'text'; messages: AgentMessage[]; startIndex: number; endIndex: number }
  | { kind: 'toolGroup'; items: GroupItem[]; startIndex: number; endIndex: number }
  | { kind: 'thinking'; message: AgentMessage; index: number }
  | { kind: 'ask'; message: AgentMessage; index: number }

const TOOL_TYPES = new Set(['tool_use:start', 'tool_use:done', 'tool_use:error', 'tool_use:invalid', 'tool_use:denied'])

function statusOf(msg: AgentMessage): ToolGroupStatus {
  switch (msg.type) {
    case 'tool_use:start': return 'pending'
    case 'tool_use:done': return 'done'
    case 'tool_use:error': return 'error'
    case 'tool_use:invalid': return 'invalid'
    case 'tool_use:denied': return 'denied'
    default: return 'done'
  }
}

/** 两种思考载体: 新的 `assistant.thinking`, 与 legacy `assistant` + thinking 字段。 */
function isThinking(m: any): boolean {
  if (m?.type === 'assistant.thinking') return true
  return m?.type === 'assistant' && typeof m.thinking === 'string' && m.thinking.length > 0
}

function pushText(buf: AgentMessage[], out: TranscriptNode[], startIndex: number, idx: number) {
  if (buf.length === 0) return
  out.push({ kind: 'text', messages: buf.slice(), startIndex, endIndex: idx - 1 })
  buf.length = 0
}

export function deriveTranscriptNodes(messages: AgentMessage[]): TranscriptNode[] {
  const out: TranscriptNode[] = []
  let textBuf: AgentMessage[] = []
  let groupBuf: GroupItem[] = []
  let groupStart = -1
  let textStart = -1

  const flushGroup = (endIdx: number) => {
    if (groupBuf.length === 0) return
    out.push({ kind: 'toolGroup', items: groupBuf.slice(), startIndex: groupStart, endIndex: endIdx })
    groupBuf = []
    groupStart = -1
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any
    const t = m?.type as string
    if (TOOL_TYPES.has(t)) {
      if (textBuf.length) pushText(textBuf, out, textStart, i)
      if (groupBuf.length === 0) groupStart = i
      groupBuf.push({ kind: 'tool', message: m, index: i, status: statusOf(m) })
      continue
    }
    if (t === 'prompt.ask') {
      flushGroup(i - 1)
      if (textBuf.length) pushText(textBuf, out, textStart, i)
      out.push({ kind: 'ask', message: m, index: i })
      textStart = -1
      continue
    }
    // 思考: 段开着就并进段里(不切断工具组), 没段才独立成节点。
    if (isThinking(m)) {
      if (groupBuf.length > 0) {
        groupBuf.push({ kind: 'thinking', message: m, index: i })
        continue
      }
      flushGroup(i - 1)
      if (textBuf.length) pushText(textBuf, out, textStart, i)
      out.push({ kind: 'thinking', message: m, index: i })
      textStart = -1
      continue
    }
    // Otherwise text bucket (user / assistant text / compact_boundary / unknown)
    flushGroup(i - 1)
    if (t === 'compact_boundary') {
      // Boundary ends the current text run and starts a new one
      if (textBuf.length) pushText(textBuf, out, textStart, i)
      textStart = i
      textBuf.push(m)
      continue
    }
    if (textBuf.length === 0) textStart = i
    textBuf.push(m)
  }

  // tail flush
  flushGroup(messages.length - 1)
  if (textBuf.length) pushText(textBuf, out, textStart, messages.length - 1)

  return out
}
