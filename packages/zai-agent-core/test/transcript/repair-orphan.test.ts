import { describe, expect, it } from 'vitest'
import type { AnthropicMessage, TranscriptMessage } from '../../src/transcript/types.js'
import { repairTranscriptToolPairs } from '../../src/transcript/repair.js'

type MessageContent = AnthropicMessage['content']

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

describe('repairTranscriptToolPairs orphan revival (spec §6a)', () => {
  it('revives a single orphan tool_use whose parentUuid is not on the active chain', () => {
    // a1 (assistant) is the active anchor; u900 (user, "continue") is a sibling
    // branch that became the active leaf; t1 is orphan (parent = u900, off the
    // active chain since u900 is not assistant). orphan revival should attach
    // t1 under a1 with a synthesized is_error tool_result.
    const a1 = record('a1', 'assistant', [])
    const orphanTool = record(
      't1',
      'tool_use',
      [{ type: 'tool_use', id: 'call-orphan-1', name: 'Bash', input: {} }],
      'u900',
    )
    const siblingResult = record(
      'r1',
      'user',
      [{ type: 'tool_result', tool_use_id: 'call-orphan-1', content: 'done', is_error: false }],
      't1',
    )
    const u900 = record('u900', 'user', 'continue', 'a1')

    const result = repairTranscriptToolPairs([a1, orphanTool, siblingResult, u900])

    expect(result.report.repaired).toBe(true)
    expect(result.report.synthesizedOrphanToolUseIds).toEqual(['call-orphan-1'])
    // orphan revived under a1 — its synthesized result message immediately follows.
    const types = result.messages.map(m => m.type)
    expect(types.indexOf('tool_use')).toBeGreaterThan(-1)
    // The revived tool is now under a1, so the result block must reference
    // an assistant anchor (parent → a1 or a descendant that precedes the result).
    const lastResult = result.messages.find(m =>
      Array.isArray(m.message?.content)
      && (m.message?.content as Array<{ type?: string }>).some(b => b.type === 'tool_result'),
    )
    expect(lastResult).toBeDefined()
    expect(lastResult?.message?.role).toBe('user')
    const blocks = lastResult?.message?.content as Array<{ type: string; is_error?: boolean; tool_use_id?: string }>
    expect(blocks.some(b => b.type === 'tool_result' && b.tool_use_id === 'call-orphan-1' && b.is_error === true)).toBe(true)
  })

  it('revives multiple orphans and groups their synthesized results into one user record', () => {
    const a1 = record('a1', 'assistant', [])
    const orphanA = record('t1', 'tool_use', [{ type: 'tool_use', id: 'orphan-a', name: 'Bash', input: {} }], 'u900')
    const orphanB = record('t2', 'tool_use', [{ type: 'tool_use', id: 'orphan-b', name: 'Read', input: {} }], 'u900')
    const u900 = record('u900', 'user', 'continue', 'a1')

    const result = repairTranscriptToolPairs([a1, orphanA, orphanB, u900])

    expect(result.report.repaired).toBe(true)
    expect(result.report.synthesizedOrphanToolUseIds.sort()).toEqual(['orphan-a', 'orphan-b'])
    // Exactly one user record carrying both tool_result blocks.
    const userResults = result.messages.filter(m => {
      const c = m.message?.content
      return Array.isArray(c) && (c as Array<{ type?: string }>).some(b => b.type === 'tool_result')
    })
    expect(userResults).toHaveLength(1)
    const ids = (userResults[0].message?.content as Array<{ tool_use_id: string }>).map(b => b.tool_use_id)
    expect(ids.sort()).toEqual(['orphan-a', 'orphan-b'])
  })

  it('keeps the bail-out behavior when an orphan appears before any active-chain assistant', () => {
    const orphanTool = record(
      't1',
      'tool_use',
      [{ type: 'tool_use', id: 'orphan-no-anchor', name: 'Bash', input: {} }],
      'root1',
    )
    const root = record('root1', 'user', 'orphan happened first', null)

    const input = [root, orphanTool]
    const result = repairTranscriptToolPairs(input)

    expect(result.report).toEqual({
      repaired: false,
      repairedToolUseIds: [],
      synthesizedToolUseIds: [],
      synthesizedOrphanToolUseIds: [],
      droppedMessageUuids: [],
    })
    expect(result.messages).toEqual(input.map(m => structuredClone(m)))
  })

  it('revives an in-chain orphan whose parent type is not assistant', () => {
    // The orphan's parentUuid IS on the active chain, but its parent is a
    // user/system/tool_use record (not an assistant). Revival should still
    // attach it to the most recent anchor assistant appearing earlier.
    const a1 = record('a1', 'assistant', [{ type: 'text', text: 'plan' }])
    const userMid = record('u1', 'user', 'mid prompt', 'a1')
    const orphanTool = record(
      't1',
      'tool_use',
      [{ type: 'tool_use', id: 'orphan-mid', name: 'Bash', input: {} }],
      'u1',
    )

    const result = repairTranscriptToolPairs([a1, userMid, orphanTool])

    expect(result.report.repaired).toBe(true)
    expect(result.report.synthesizedOrphanToolUseIds).toEqual(['orphan-mid'])
    // Orphan revived under a1; the user prompt u1 still appears after the
    // assistant's tool_pair group.
    const types = result.messages.map(m => m.type)
    const tIdx = types.indexOf('tool_use')
    const uIdx = types.indexOf('user')
    expect(tIdx).toBeLessThan(uIdx)
  })

  it('protocol remains valid after orphan revival', () => {
    const a1 = record('a1', 'assistant', [])
    const orphanA = record('t1', 'tool_use', [{ type: 'tool_use', id: 'orphan-a', name: 'Bash', input: {} }], 'u900')
    const orphanB = record('t2', 'tool_use', [{ type: 'tool_use', id: 'orphan-b', name: 'Read', input: {} }], 'u900')
    const u900 = record('u900', 'user', 'continue', 'a1')

    const result = repairTranscriptToolPairs([a1, orphanA, orphanB, u900])
    expect(result.report.repaired).toBe(true)

    // Re-running on already repaired messages must be idempotent (no further changes).
    const second = repairTranscriptToolPairs(result.messages)
    expect(second.report.repaired).toBe(false)
  })
})
