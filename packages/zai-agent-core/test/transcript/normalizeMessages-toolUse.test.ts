import { describe, expect, it } from 'bun:test'
import {
  foldTopLevelToolUses,
  type FoldableMessage,
} from '../../src/opencc-internals/utils/foldTopLevelToolUses.js'

/**
 * Regression suite for sess-013f9f87-39dd-46a2-a26a-b7da951c1240 (and any
 * other transcript that persisted parallel tool_use blocks as separate
 * top-level messages).
 *
 * The transcript v2 protocol saves an assistant turn that emits N tool_use
 * blocks in parallel as 1 + N top-level TranscriptMessage records:
 *   - one parent assistant record (content = [thinking])
 *   - N children each with type=tool_use, parentUuid=<parentUuid>, and
 *     message.content = [tool_use block]
 *
 * `normalizeMessagesForAPI` had a switch covering only
 * `user|assistant|attachment|system`. The default branch silently dropped
 * `type=tool_use` records while leaving their matching user tool_result
 * records intact, producing a request body whose tool_result.tool_use_id
 * values referenced ids the model never saw. Anthropic replied with HTTP
 * 400 error 2013:
 *   "invalid params, tool result's tool id(<id>) not found"
 *
 * The fix is `foldTopLevelToolUses`, a pure helper that is invoked after
 * the type filter and before the switch dispatch in
 * `normalizeMessagesForAPI`. It folds each top-level tool_use record back
 * into its parent assistant message in source order, preserving the
 * pairing that the API requires.
 */

type Block =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: unknown
    }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }

const makeAssistant = (
  uuid: string,
  content: Block[],
  parentUuid?: string,
): FoldableMessage => ({
  uuid,
  parentUuid,
  type: 'assistant',
  message: { content },
})

const makeTopLevelToolUse = (
  uuid: string,
  block: Extract<Block, { type: 'tool_use' }>,
  parentUuid: string,
): FoldableMessage => ({
  uuid,
  parentUuid,
  type: 'tool_use',
  message: { content: [block] },
})

const makeUserToolResult = (
  uuid: string,
  block: Extract<Block, { type: 'tool_result' }>,
  parentUuid?: string,
): FoldableMessage => ({
  uuid,
  parentUuid,
  type: 'user',
  message: { content: [block] },
})

const blockTypes = (m: FoldableMessage): string[] => {
  const c = m.message?.content
  return Array.isArray(c) ? c.map(b => b.type) : []
}

const toolUseIds = (m: FoldableMessage): string[] => {
  const c = m.message?.content
  if (!Array.isArray(c)) return []
  return c.filter(b => b.type === 'tool_use').map(b => (b as { id: string }).id)
}

const toolResultIds = (m: FoldableMessage): string[] => {
  const c = m.message?.content
  if (!Array.isArray(c)) return []
  return c
    .filter(b => b.type === 'tool_result')
    .map(b => (b as { tool_use_id: string }).tool_use_id)
}

describe('foldTopLevelToolUses — parallel tool_use child folding', () => {
  it('folds a single tool_use child into its parent assistant message', () => {
    const parent = makeAssistant('parent', [
      { type: 'thinking', thinking: 'let me check' },
    ])
    const child = makeTopLevelToolUse(
      'tu-1',
      { type: 'tool_use', id: 'call_x_1', name: 'Bash', input: { cmd: 'ls' } },
      'parent',
    )

    const out = foldTopLevelToolUses([parent, child])

    expect(out).toHaveLength(1)
    expect(blockTypes(out[0])).toEqual(['thinking', 'tool_use'])
    expect(toolUseIds(out[0])).toEqual(['call_x_1'])
  })

  it('preserves order of multiple parallel tool_use children', () => {
    const parent = makeAssistant('parent', [
      { type: 'thinking', thinking: 'hmm' },
    ])
    const c1 = makeTopLevelToolUse(
      'tu-1',
      {
        type: 'tool_use',
        id: 'call_x_1',
        name: 'Glob',
        input: { p: '*.test.ts' },
      },
      'parent',
    )
    const c2 = makeTopLevelToolUse(
      'tu-2',
      { type: 'tool_use', id: 'call_x_2', name: 'Bash', input: { cmd: 'ls' } },
      'parent',
    )
    const c3 = makeTopLevelToolUse(
      'tu-3',
      {
        type: 'tool_use',
        id: 'call_x_3',
        name: 'Read',
        input: { file: '/x' },
      },
      'parent',
    )

    const out = foldTopLevelToolUses([parent, c1, c2, c3])

    expect(out).toHaveLength(1)
    expect(toolUseIds(out[0])).toEqual(['call_x_1', 'call_x_2', 'call_x_3'])
  })

  it('keeps tool_use ↔ tool_result pairing intact (sess-013f9f87 root case)', () => {
    const parent = makeAssistant('a-parent-385563d6', [
      {
        type: 'thinking',
        thinking: 'start opencc-web tests — find tests first',
      },
    ])
    const tu1 = makeTopLevelToolUse(
      't-035b5558',
      {
        type: 'tool_use',
        id: 'call_a_1',
        name: 'Glob',
        input: { pattern: '**/*.test.ts', path: '/x' },
      },
      'a-parent-385563d6',
    )
    const tr1 = makeUserToolResult(
      'u-193505e7',
      { type: 'tool_result', tool_use_id: 'call_a_1', content: 'matches...' },
      't-035b5558',
    )
    const tu2 = makeTopLevelToolUse(
      't-df43cfec',
      {
        type: 'tool_use',
        id: 'call_a_2',
        name: 'Glob',
        input: { pattern: '**/package.json', path: '/x' },
      },
      'a-parent-385563d6',
    )
    const tr2 = makeUserToolResult(
      'u-6bfbc16d',
      { type: 'tool_result', tool_use_id: 'call_a_2', content: 'matches...' },
      't-df43cfec',
    )

    const out = foldTopLevelToolUses([parent, tu1, tr1, tu2, tr2])

    // After fold: assistant[thinking, tool_use_a_1, tool_use_a_2], user[tr_a_1], user[tr_a_2]
    // (the helper does not merge user messages — that is mergeAdjacentUserMessages'
    // job downstream — but it MUST keep the user tool_result records intact).
    const assistantMessages = out.filter(m => m.type === 'assistant')
    const userMessages = out.filter(m => m.type === 'user')

    expect(assistantMessages).toHaveLength(1)
    expect(toolUseIds(assistantMessages[0])).toEqual(['call_a_1', 'call_a_2'])

    expect(userMessages).toHaveLength(2)
    expect(toolResultIds(userMessages[0])).toEqual(['call_a_1'])
    expect(toolResultIds(userMessages[1])).toEqual(['call_a_2'])

    // Hard invariant: every tool_result.tool_use_id must resolve to a
    // tool_use.id in the assistant's content. This is exactly what the API
    // requires and exactly what was broken before the fix.
    const allAssistantToolUseIds = new Set<string>()
    for (const a of assistantMessages)
      for (const id of toolUseIds(a)) allAssistantToolUseIds.add(id)
    for (const u of userMessages)
      for (const id of toolResultIds(u))
        expect(allAssistantToolUseIds.has(id)).toBe(true)
  })

  it('appends tool_use blocks after existing assistant content (text stays first)', () => {
    const parent = makeAssistant('parent', [
      {
        type: 'text',
        text: 'I will run two commands in parallel.',
      },
    ])
    const child = makeTopLevelToolUse(
      'tu-1',
      { type: 'tool_use', id: 'call_y_1', name: 'Bash', input: {} },
      'parent',
    )

    const out = foldTopLevelToolUses([parent, child])

    expect(out).toHaveLength(1)
    expect(blockTypes(out[0])).toEqual(['text', 'tool_use'])
  })

  it('converts an orphan tool_use into a standalone assistant message (no silent drop)', () => {
    const orphan = makeTopLevelToolUse(
      'tu-orphan',
      { type: 'tool_use', id: 'call_w_1', name: 'Bash', input: {} },
      'a-orphan-does-not-exist',
    )

    const out = foldTopLevelToolUses([orphan])

    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('assistant')
    expect(toolUseIds(out[0])).toEqual(['call_w_1'])
  })

  it('does not mutate the input array', () => {
    const parent = makeAssistant('parent', [
      { type: 'thinking', thinking: 'hmm' },
    ])
    const child = makeTopLevelToolUse(
      'tu-1',
      { type: 'tool_use', id: 'call_z_1', name: 'Bash', input: {} },
      'parent',
    )
    const original: FoldableMessage[] = [parent, child]
    const originalSnapshot = JSON.parse(JSON.stringify(original))

    foldTopLevelToolUses(original)

    expect(JSON.parse(JSON.stringify(original))).toEqual(originalSnapshot)
    expect(original[0].type).toBe('assistant')
    expect(original[1].type).toBe('tool_use') // child preserved in input
  })

  it('de-duplicates by tool_use id when the same id appears twice', () => {
    const parent = makeAssistant('parent', [
      { type: 'thinking', thinking: 'hmm' },
    ])
    const childA = makeTopLevelToolUse(
      'tu-a',
      { type: 'tool_use', id: 'call_dup', name: 'Bash', input: { v: 1 } },
      'parent',
    )
    const childB = makeTopLevelToolUse(
      'tu-b',
      { type: 'tool_use', id: 'call_dup', name: 'Bash', input: { v: 2 } },
      'parent',
    )

    const out = foldTopLevelToolUses([parent, childA, childB])

    const assistant = out.find(m => m.type === 'assistant')!
    const toolUseBlocks = (assistant.message!.content as Block[]).filter(
      b => b.type === 'tool_use',
    )
    expect(toolUseBlocks).toHaveLength(1)
  })
})
