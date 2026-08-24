import { describe, expect, it } from 'vitest'
import {
  SubagentStartEvent,
  SubagentEndEvent,
  SubagentDescriptorEvent,
  SubagentStateEvent,
  SubagentMessageEvent,
  SubagentErrorEvent,
  SubagentContentBlockSchema,
} from '../../src/shared/subagentEvents.js'

describe('subagentEvents', () => {
  it('parses subagent.start payload', () => {
    const ok = SubagentStartEvent.parse({
      type: 'subagent.start',
      ts: 1700000000,
      sessionId: 's1',
      runId: 'r1',
      provider: 'spawn',
      id: 'dsh-task-xxx',
      local: true,
      parentSessionId: 'p1',
    })
    expect(ok.runId).toBe('r1')
  })

  it('parses subagent.end with lastAssistantMessage', () => {
    const ok = SubagentEndEvent.parse({
      type: 'subagent.end',
      ts: 1700000000,
      sessionId: 's1',
      runId: 'r1',
      provider: 'spawn',
      id: 'dsh-task-xxx',
      local: true,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'hello' }],
    })
    expect(ok.stopReason).toBe('completed')
  })

  it('rejects subagent.end with invalid stopReason', () => {
    expect(() =>
      SubagentEndEvent.parse({
        type: 'subagent.end', ts: 0, sessionId: 's1', runId: 'r1',
        provider: 'spawn', id: 'x', local: true, stopReason: 'bogus',
      }),
    ).toThrow()
  })

  it('parses subagent.descriptor with mode/persona/toolFilter', () => {
    const ok = SubagentDescriptorEvent.parse({
      type: 'subagent.descriptor',
      ts: 0, sessionId: 's1', runId: 'r1',
      version: 2, mode: 'one-shot', provider: 'spawn',
      label: 'investigate-x', persona: 'you are a tester',
      toolFilter: ['Read', 'Grep'],
    })
    expect(ok.mode).toBe('one-shot')
    expect(ok.toolFilter).toEqual(['Read', 'Grep'])
  })

  it('parses subagent.state with running/waiting/settled', () => {
    for (const state of ['running', 'waiting', 'settled'] as const) {
      const ok = SubagentStateEvent.parse({
        type: 'subagent.state', ts: 0, sessionId: 's1', runId: 'r1', state,
      })
      expect(ok.state).toBe(state)
    }
  })

  it('parses subagent.message with ContentBlock[]', () => {
    const ok = SubagentMessageEvent.parse({
      type: 'subagent.message',
      ts: 0, sessionId: 's1', runId: 'r1',
      blocks: [
        { type: 'thinking', thinking: 'reasoning...' },
        { type: 'text', text: 'final answer' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { path: '/a' } },
        { type: 'tool_result', tool_use_id: 'tu1', content: 'contents', is_error: false },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
      ],
    })
    expect(ok.blocks).toHaveLength(5)
  })

  it('parses subagent.error payload', () => {
    const ok = SubagentErrorEvent.parse({
      type: 'subagent.error', ts: 0, sessionId: 's1', runId: 'r1',
      message: 'boom', code: 'TIMEOUT',
    })
    expect(ok.code).toBe('TIMEOUT')
  })

  it('SubagentContentBlockSchema rejects unknown type', () => {
    expect(() =>
      SubagentContentBlockSchema.parse({ type: 'bogus', x: 1 }),
    ).toThrow()
  })
})
