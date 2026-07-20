import { describe, expect, it } from 'vitest'
import type { AnthropicMessage, TranscriptMessage } from '../../src/transcript/types.js'
import { repairTranscriptToolPairs } from '../../src/transcript/repair.js'

type MessageContent = AnthropicMessage['content']

const toolResults = (message: TranscriptMessage): Array<{ tool_use_id: string; is_error?: boolean; type: string }> => {
  const content = message.message?.content
  if (!Array.isArray(content)) return []
  return content.filter((block): block is { tool_use_id: string; is_error?: boolean; type: string } =>
    typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result')
}

const record = (
  uuid: string,
  type: TranscriptMessage['type'],
  content: MessageContent,
  parentUuid: string | null = null,
): TranscriptMessage => ({
  uuid,
  parentUuid,
  timestamp: Number(uuid.replace(/\D/g, '') || 1),
  cwd: '/x',
  userType: 'zai',
  sessionId: 's',
  version: '2',
  isSidechain: false,
  raw: null,
  type,
  message: { role: type === 'assistant' || type === 'tool_use' ? 'assistant' : 'user', content },
})

describe('repairTranscriptToolPairs', () => {
  it('moves a delayed tool_result directly after its tool_use turn', () => {
    const assistant = record('a1', 'assistant', [{ type: 'text', text: 'run it' }])
    const tool = record('t1', 'tool_use', [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }], 'a1')
    const nextPrompt = record('u2', 'user', 'continue', 't1')
    const delayedResult = record('r1', 'user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done', is_error: false }], 't1')

    const result = repairTranscriptToolPairs([assistant, tool, nextPrompt, delayedResult])
    const messages = result.messages

    expect(messages.map(message => message.type)).toEqual(['assistant', 'tool_use', 'user', 'user'])
    expect(messages[2].message?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call-1', content: 'done', is_error: false },
    ])
    expect(messages[3].message?.content).toBe('continue')
    expect(result.report.repairedToolUseIds).toEqual(['call-1'])
  })

  it('synthesizes an error result for an unresolved tool_use', () => {
    const assistant = record('a1', 'assistant', [])
    const tool = record('t1', 'tool_use', [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }], 'a1')

    const result = repairTranscriptToolPairs([assistant, tool])
    const recovery = result.messages.at(-1)?.message?.content

    expect(recovery).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'call-1', is_error: true }),
    ])
    expect(result.report.synthesizedToolUseIds).toEqual(['call-1'])
  })

  it('groups parallel tool results into one user record and preserves child order', () => {
    const assistant = record('a1', 'assistant', [])
    const toolA = record(
      't1',
      'tool_use',
      [{ type: 'tool_use', id: 'call-a', name: 'Bash', input: {} }],
      'a1',
    )
    const toolB = record(
      't2',
      'tool_use',
      [{ type: 'tool_use', id: 'call-b', name: 'Read', input: {} }],
      'a1',
    )
    const resultB = record(
      'r2',
      'user',
      [{ type: 'tool_result', tool_use_id: 'call-b', content: 'b', is_error: false }],
      't2',
    )
    const resultA = record(
      'r1',
      'user',
      [{ type: 'tool_result', tool_use_id: 'call-a', content: 'a', is_error: false }],
      't1',
    )

    const result = repairTranscriptToolPairs([assistant, toolA, toolB, resultB, resultA])
    const toolResults = result.messages.filter(message => {
      const content = message.message?.content
      return Array.isArray(content) && content.some(block => block.type === 'tool_result')
    })

    expect(result.messages.map(message => message.type)).toEqual(['assistant', 'tool_use', 'tool_use', 'user'])
    expect(toolResults).toHaveLength(1)
    expect((toolResults[0].message?.content as Array<{ tool_use_id: string }>).map(block => block.tool_use_id))
      .toEqual(['call-a', 'call-b'])
  })

  it('repairs a result when the next prompt is a sibling of the tool_use', () => {
    const assistant = record('a1', 'assistant', [])
    const tool = record(
      't1',
      'tool_use',
      [{ type: 'tool_use', id: 'call-sibling', name: 'Bash', input: {} }],
      'a1',
    )
    const nextPrompt = record('u900', 'user', 'continue', 'a1')
    const delayedResult = record(
      'r800',
      'user',
      [{ type: 'tool_result', tool_use_id: 'call-sibling', content: 'done', is_error: false }],
      't1',
    )

    const result = repairTranscriptToolPairs([assistant, tool, nextPrompt, delayedResult])

    expect(result.messages.map(message => message.type)).toEqual(['assistant', 'tool_use', 'user', 'user'])
    expect((result.messages[2].message?.content as Array<{ tool_use_id?: string }>)[0]?.tool_use_id)
      .toBe('call-sibling')
    expect(result.messages[3].message?.content).toBe('continue')
  })

  it('drops a disconnected branch and reports its UUIDs', () => {
    const root = record('a1', 'assistant', [])
    const stale = record('a800', 'assistant', [{ type: 'text', text: 'stale' }], 'a1')
    const active = record('u900', 'user', 'active', 'a1')

    const result = repairTranscriptToolPairs([root, stale, active])

    expect(result.messages.map(message => message.uuid)).toEqual(['a1', 'u900'])
    expect(result.report.droppedMessageUuids).toEqual(['a800'])
  })

  it('revives an orphan whose active-chain parent is not an assistant', () => {
    const a1 = record('a1', 'assistant', [])
    const userMid = record('u900', 'user', 'continue', 'a1')
    const orphan = record(
      't1',
      'tool_use',
      [{ type: 'tool_use', id: 'call-orphan', name: 'Bash', input: {} }],
      'u900',
    )
    const delayedResult = record(
      'r1',
      'user',
      [{ type: 'tool_result', tool_use_id: 'call-orphan', content: 'done', is_error: false }],
      't1',
    )
    const input = [a1, userMid, orphan, delayedResult]

    const result = repairTranscriptToolPairs(input)

    expect(result.report.repaired).toBe(true)
    expect(result.report.synthesizedOrphanToolUseIds).toEqual(['call-orphan'])
    const userResults = result.messages.filter(message => toolResults(message).length > 0)
    expect(userResults).toHaveLength(1)
    expect((userResults[0].message?.content as Array<{ tool_use_id: string; is_error?: boolean }>)[0])
      .toMatchObject({ tool_use_id: 'call-orphan', is_error: true })
  })

  it('does not mutate input and is idempotent', () => {
    const input = [
      record('a1', 'assistant', []),
      record('t1', 'tool_use', [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }], 'a1'),
    ]
    const snapshot = structuredClone(input)

    const first = repairTranscriptToolPairs(input)
    const second = repairTranscriptToolPairs(first.messages)

    expect(input).toEqual(snapshot)
    expect(first.report.repaired).toBe(true)
    expect(second.report.repaired).toBe(false)
    expect(second.messages).toEqual(first.messages)
  })
})
