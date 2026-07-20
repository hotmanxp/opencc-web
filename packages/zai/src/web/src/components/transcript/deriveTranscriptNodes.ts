import type { AgentMessage } from '../../store/useAgentStore.js'

export type ToolGroupStatus = 'pending' | 'done' | 'error' | 'invalid' | 'denied'

export type ToolGroupEntry = {
  message: AgentMessage
  index: number
  status: ToolGroupStatus
}

export type TranscriptNode =
  | { kind: 'text'; messages: AgentMessage[]; startIndex: number; endIndex: number }
  | { kind: 'toolGroup'; toolCalls: ToolGroupEntry[]; startIndex: number; endIndex: number }
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

function pushText(buf: AgentMessage[], out: TranscriptNode[], startIndex: number, idx: number) {
  if (buf.length === 0) return
  out.push({ kind: 'text', messages: buf.slice(), startIndex, endIndex: idx - 1 })
  buf.length = 0
}

export function deriveTranscriptNodes(messages: AgentMessage[]): TranscriptNode[] {
  const out: TranscriptNode[] = []
  let textBuf: AgentMessage[] = []
  let groupBuf: ToolGroupEntry[] = []
  let groupStart = -1
  let textStart = -1

  const flushGroup = (endIdx: number) => {
    if (groupBuf.length === 0) return
    out.push({ kind: 'toolGroup', toolCalls: groupBuf.slice(), startIndex: groupStart, endIndex: endIdx })
    groupBuf = []
    groupStart = -1
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any
    const t = m?.type as string
    if (TOOL_TYPES.has(t)) {
      if (textBuf.length) pushText(textBuf, out, textStart, i)
      if (groupBuf.length === 0) groupStart = i
      groupBuf.push({ message: m, index: i, status: statusOf(m) })
      continue
    }
    if (t === 'prompt.ask') {
      flushGroup(i - 1)
      if (textBuf.length) pushText(textBuf, out, textStart, i)
      out.push({ kind: 'ask', message: m, index: i })
      textStart = -1
      continue
    }
    // Assistant message: if it carries a `thinking` field, treat as thinking pass-through.
    if (t === 'assistant' && typeof m.thinking === 'string' && m.thinking.length > 0) {
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
