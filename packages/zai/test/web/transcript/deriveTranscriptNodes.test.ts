import { describe, it, expect } from 'vitest'
import type { AgentMessage } from '../../../src/web/src/store/useAgentStore.js'
import { deriveTranscriptNodes } from '../../../src/web/src/components/transcript/deriveTranscriptNodes.js'

// Lightweight factory — only fields we read. Real AgentMessage has more.
function userMsg(text: string, idx: number): AgentMessage {
  return { type: 'user', text, eventId: `u-${idx}`, sendSeq: 0, turnIndex: 0, blockIndex: 0 } as AgentMessage
}
function assistantMsg(text: string, idx: number): AgentMessage {
  return { type: 'assistant', text, eventId: `a-${idx}`, sendSeq: 0, turnIndex: 0, blockIndex: 0 } as AgentMessage
}
function toolStart(name: string, idx: number, toolUseId: string): AgentMessage {
  return { type: 'tool_use:start', toolName: name, toolUseId, eventId: `t-${idx}`, sendSeq: 0, turnIndex: 0, blockIndex: 0 } as AgentMessage
}
function toolDone(name: string, idx: number, toolUseId: string): AgentMessage {
  return { type: 'tool_use:done', toolName: name, toolUseId, eventId: `d-${idx}`, sendSeq: 0, turnIndex: 0, blockIndex: 0 } as AgentMessage
}
function toolError(toolUseId: string, idx: number): AgentMessage {
  return { type: 'tool_use:error', toolUseId, eventId: `e-${idx}`, sendSeq: 0, turnIndex: 0, blockIndex: 0 } as AgentMessage
}
function thinkingMsg(text: string, idx: number): AgentMessage {
  return { type: 'assistant', thinking: text, eventId: `th-${idx}`, sendSeq: 0, turnIndex: 0, blockIndex: 0 } as AgentMessage
}
function askMsg(idx: number): AgentMessage {
  return { type: 'prompt.ask', questions: [{ question: 'q', header: 'h', options: [] }], toolUseId: `ask-${idx}`, sessionId: 's', eventId: `ask-${idx}` } as unknown as AgentMessage
}
function boundaryMsg(idx: number): AgentMessage {
  return { type: 'compact_boundary', eventId: `b-${idx}` } as unknown as AgentMessage
}

describe('deriveTranscriptNodes', () => {
  it('case 1: empty array', () => {
    expect(deriveTranscriptNodes([])).toEqual([])
  })

  it('case 2: single user text → single TextNode', () => {
    const out = deriveTranscriptNodes([userMsg('hi', 0)])
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('text')
  })

  it('case 3: user + 1 tool + done → [text, toolGroup, text]', () => {
    const msgs = [
      userMsg('do', 0),
      toolStart('Bash', 1, 'tu1'),
      toolDone('Bash', 2, 'tu1'),
      assistantMsg('done', 3),
    ]
    const out = deriveTranscriptNodes(msgs)
    expect(out.map(n => n.kind)).toEqual(['text', 'toolGroup', 'text'])
    expect(out[1].kind === 'toolGroup' && out[1].toolCalls).toHaveLength(2)
  })

  it('case 4: user + 3 consecutive tools + user → [text, toolGroup(len=6 entries), text]', () => {
    const msgs = [
      userMsg('build', 0),
      toolStart('Bash', 1, 't1'), toolDone('Bash', 2, 't1'),
      toolStart('Read', 3, 't2'), toolDone('Read', 4, 't2'),
      toolStart('Edit', 5, 't3'), toolDone('Edit', 6, 't3'),
      assistantMsg('done', 7),
    ]
    const out = deriveTranscriptNodes(msgs)
    expect(out.map(n => n.kind)).toEqual(['text', 'toolGroup', 'text'])
    if (out[1].kind === 'toolGroup') {
      expect(out[1].toolCalls).toHaveLength(6)
    }
  })

  it('case 5: thinking pass-through separates tool groups', () => {
    const msgs = [
      userMsg('q', 0),
      toolStart('Bash', 1, 't1'), toolDone('Bash', 2, 't1'),
      thinkingMsg('hmm', 3),
      userMsg('q2', 4),
    ]
    const out = deriveTranscriptNodes(msgs)
    // thinking bumps startIndex — must NOT be inside the tool group
    expect(out.map(n => n.kind)).toEqual(['text', 'toolGroup', 'thinking', 'text'])
  })

  it('case 6: tool_use:start without :done → group with status:pending', () => {
    const msgs = [
      userMsg('q', 0),
      toolStart('Bash', 1, 't1'),
      userMsg('q2', 2),
    ]
    const out = deriveTranscriptNodes(msgs)
    expect(out.map(n => n.kind)).toEqual(['text', 'toolGroup', 'text'])
    if (out[1].kind === 'toolGroup') {
      expect(out[1].toolCalls[0].status).toBe('pending')
    }
  })

  it('case 7: tool_use:error counts toward failure badge', () => {
    const msgs = [
      userMsg('q', 0),
      toolStart('Bash', 1, 't1'), toolDone('Bash', 2, 't1'),
      toolStart('Read', 3, 't2'), toolError('t2', 4),
      toolStart('Edit', 5, 't3'), toolDone('Edit', 6, 't3'),
      userMsg('q2', 7),
    ]
    const out = deriveTranscriptNodes(msgs)
    const grp = out.find(n => n.kind === 'toolGroup')
    if (grp && grp.kind === 'toolGroup') {
      const errs = grp.toolCalls.filter(e => e.status === 'error')
      expect(errs).toHaveLength(1)
    }
  })

  it('case 8: compact_boundary renders as text-node entry', () => {
    const msgs = [userMsg('q', 0), boundaryMsg(1), userMsg('q2', 2)]
    const out = deriveTranscriptNodes(msgs)
    // boundary sits in the text bucket — ends one text-run, starts the next
    expect(out.filter(n => n.kind === 'text').length).toBeGreaterThanOrEqual(2)
  })

  it('case 9: AskUserQuestion stays ask, never joins toolGroup', () => {
    const msgs = [
      userMsg('q', 0),
      toolStart('Bash', 1, 't1'),
      askMsg(2),
      toolDone('Bash', 3, 't1'),
    ]
    const out = deriveTranscriptNodes(msgs)
    expect(out.some(n => n.kind === 'ask')).toBe(true)
    const grp = out.find(n => n.kind === 'toolGroup')
    if (grp && grp.kind === 'toolGroup') {
      expect(grp.toolCalls).toHaveLength(1) // only :start — :done is on the other side of ask
    }
  })
})
