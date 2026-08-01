/**
 * Regression tests for serializeForAnthropic — the function zai's
 * resume path uses to convert prior transcript turns into the shape
 * `params.messages` expects. Without correct merging, sessions with
 * back-to-back tool_use entries produce consecutive assistant messages,
 * which Anthropic's Messages API rejects with 400 invalid_request_error.
 * The user then sees no LLM reply on the next turn — and on page
 * refresh, the persisted session shows an error assistant block instead
 * of the tool call they triggered.
 */
import { describe, expect, it } from 'vitest'
import { serializeForAnthropic } from '../../../src/compat/transcript/persistence.js'
import type { TranscriptMessage } from '../../../src/compat/transcript/types.js'

function mkMsg(overrides: Partial<TranscriptMessage>): TranscriptMessage {
  return {
    uuid: overrides.uuid ?? `u-${Math.random().toString(36).slice(2, 10)}`,
    parentUuid: overrides.parentUuid ?? null,
    type: overrides.type ?? 'user',
    timestamp: overrides.timestamp ?? Date.now(),
    raw: null,
    version: '2',
    message: overrides.message,
    ...overrides,
  } as TranscriptMessage
}

describe('serializeForAnthropic — Anthropic protocol alternation', () => {
  it('merges back-to-back tool_use transcript entries into one assistant message', () => {
    // Two consecutive tool_use entries (one per Bash call) must collapse
    // into a single assistant message. Otherwise the LLM API returns 400.
    const out = serializeForAnthropic([
      mkMsg({
        uuid: 'tu-A',
        type: 'tool_use',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_A', name: 'Bash', input: { command: 'pwd' } }],
        },
      }),
      mkMsg({
        uuid: 'tu-B',
        type: 'tool_use',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_B', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('assistant')
    const blocks = out[0].content as Array<{ type: string; id?: string }>
    expect(blocks.map((b) => b.type)).toEqual(['tool_use', 'tool_use'])
    expect(blocks.map((b) => b.id)).toEqual(['call_A', 'call_B'])
  })

  it('merges an assistant text message followed by a tool_use entry', () => {
    const out = serializeForAnthropic([
      mkMsg({
        uuid: 'asst-text',
        type: 'assistant',
        message: { role: 'assistant', content: 'OK, let me run pwd.' },
      }),
      mkMsg({
        uuid: 'tu-A',
        type: 'tool_use',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_A', name: 'Bash', input: { command: 'pwd' } }],
        },
      }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('assistant')
    const blocks = out[0].content as Array<{ type: string }>
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool_use'])
  })

  it('keeps separate assistant messages when separated by a user turn', () => {
    const out = serializeForAnthropic([
      mkMsg({
        uuid: 'tu-A',
        type: 'tool_use',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_A', name: 'Bash', input: { command: 'pwd' } }],
        },
      }),
      mkMsg({
        uuid: 'tr-A',
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_A', content: '/tmp', is_error: false }],
        },
      }),
      mkMsg({
        uuid: 'tu-B',
        type: 'tool_use',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_B', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
    ])
    expect(out).toHaveLength(3)
    expect(out.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant'])
  })

  it('groups consecutive tool_result user entries under one user message', () => {
    const out = serializeForAnthropic([
      mkMsg({
        uuid: 'tr-A',
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_A', content: '/tmp', is_error: false }],
        },
      }),
      mkMsg({
        uuid: 'tr-B',
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_B', content: 'file.txt', is_error: false }],
        },
      }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    const blocks = out[0].content as Array<{ type: string; tool_use_id?: string }>
    expect(blocks.map((b) => b.type)).toEqual(['tool_result', 'tool_result'])
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['call_A', 'call_B'])
  })
})