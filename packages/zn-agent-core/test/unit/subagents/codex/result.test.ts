import { describe, it, expect } from 'vitest'
import {
  resolveFinalAnswer,
  stopReasonFromTurnTerminal,
} from '../../../../src/compat/subagents/codex/result.js'
import type { SubagentEvent } from '../../../../src/compat/subagents/registry.js'

/**
 * Unit tests for the final-answer resolution rule (result.ts).
 *
 * Mirrors dsh-subagent-codex's logic:
 *   - latest agentMessage with phase: 'final_answer' wins
 *   - fallback: latest agentMessage with phase: null
 *   - commentary never replaces the answer
 *   - blank → error
 */

function agentMessage(phase: 'final_answer' | null | undefined, text: string): SubagentEvent {
  return {
    type: 'agentMessage',
    phase: phase ?? null,
    text,
    raw: { text, phase },
  }
}

describe('codex/result.resolveFinalAnswer', () => {
  it('returns the latest final_answer message as the answer text', () => {
    const events: SubagentEvent[] = [
      agentMessage(null, 'thinking...'),
      agentMessage('final_answer', 'First answer'),
      agentMessage(null, 'more thinking'),
      agentMessage('final_answer', 'Last answer wins'),
    ]
    const r = resolveFinalAnswer(events)
    expect(r.stopReason).toBe('completed')
    expect(r.text).toBe('Last answer wins')
  })

  it('falls back to the latest phase: null message when no final_answer is present', () => {
    const events: SubagentEvent[] = [
      agentMessage(null, 'early'),
      agentMessage(null, 'middle'),
      agentMessage(null, 'latest fallback'),
    ]
    const r = resolveFinalAnswer(events)
    expect(r.stopReason).toBe('completed')
    expect(r.text).toBe('latest fallback')
  })

  it('ignores commentary events when resolving the answer', () => {
    const events: SubagentEvent[] = [
      agentMessage(null, 'thinking...'),
      { type: 'commentary', text: 'tool planning note', raw: {} },
      agentMessage('final_answer', 'Actual answer'),
    ]
    const r = resolveFinalAnswer(events)
    expect(r.stopReason).toBe('completed')
    expect(r.text).toBe('Actual answer')
  })

  it('returns error when only commentary is present', () => {
    const events: SubagentEvent[] = [
      { type: 'commentary', text: 'noise', raw: {} },
      { type: 'commentary', text: 'more noise', raw: {} },
    ]
    const r = resolveFinalAnswer(events)
    expect(r.stopReason).toBe('error')
    expect(r.errorMessage).toMatch(/commentary/i)
    expect(r.text).toBe('')
  })

  it('returns error when final_answer is blank', () => {
    const events: SubagentEvent[] = [agentMessage('final_answer', '   ')]
    const r = resolveFinalAnswer(events)
    expect(r.stopReason).toBe('error')
    expect(r.text).toBe('')
  })

  it('returns error when no events land at all', () => {
    const r = resolveFinalAnswer([])
    expect(r.stopReason).toBe('error')
    expect(r.errorMessage).toMatch(/no agentMessage/)
    expect(r.text).toBe('')
  })
})

describe('codex/result.stopReasonFromTurnTerminal', () => {
  it('success maps to completed', () => {
    expect(stopReasonFromTurnTerminal({ status: 'success' })).toEqual({ stopReason: 'completed' })
  })

  it('contextWindowExceeded maps to max-tokens', () => {
    expect(
      stopReasonFromTurnTerminal({
        status: 'error',
        codexErrorInfo: 'contextWindowExceeded',
        errorMessage: 'context too big',
      }),
    ).toEqual({ stopReason: 'max-tokens' })
  })

  it('plain error maps to error with message', () => {
    expect(
      stopReasonFromTurnTerminal({ status: 'error', errorMessage: 'something broke' }),
    ).toEqual({ stopReason: 'error', errorMessage: 'something broke' })
  })

  it('error without message carries a default', () => {
    expect(stopReasonFromTurnTerminal({ status: 'error' })).toEqual({
      stopReason: 'error',
      errorMessage: expect.stringMatching(/failed without/i),
    })
  })

  it('interrupted maps to error (no native refusal terminal)', () => {
    expect(
      stopReasonFromTurnTerminal({ status: 'interrupted', errorMessage: 'killed' }),
    ).toEqual({ stopReason: 'error', errorMessage: 'killed' })
  })
})
