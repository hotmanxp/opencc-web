import { describe, it, expect } from 'vitest'
import type { SubagentEvent } from '../../../../src/compat/subagents/registry.js'
import {
  opencodeLineToEvent,
  collectOpencodeAnswerParts,
  lastStepFinishPart,
  resolveOpencodeAnswer,
} from '../../../../src/compat/subagents/opencode/result.js'

const okTerm = { exitCode: 0, signal: null, stderrTail: '' }

function frameEvent(obj: unknown): SubagentEvent {
  return opencodeLineToEvent(JSON.stringify(obj))
}

describe('opencode/result.opencodeLineToEvent', () => {
  it('maps a text frame onto a text event carrying part.text', () => {
    const ev = opencodeLineToEvent(
      JSON.stringify({ type: 'text', part: { id: 'a', type: 'text', text: 'hi' } }),
    )
    expect(ev.type).toBe('text')
    expect(ev.text).toBe('hi')
  })

  it('passes step_start / step_finish through with raw fidelity', () => {
    const ss = opencodeLineToEvent(JSON.stringify({ type: 'step_start', part: {} }))
    const sf = opencodeLineToEvent(
      JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }),
    )
    expect(ss.type).toBe('step_start')
    expect(sf.type).toBe('step_finish')
    expect((sf.raw as { part: { reason: string } }).part.reason).toBe('stop')
  })

  it('forwards an unknown frame type verbatim', () => {
    const ev = opencodeLineToEvent(JSON.stringify({ type: 'tool_call', foo: 1 }))
    expect(ev.type).toBe('tool_call')
    expect((ev.raw as { foo: number }).foo).toBe(1)
  })

  it('degrades a non-JSON line to a log event (never throws)', () => {
    const ev = opencodeLineToEvent('this is not json')
    expect(ev.type).toBe('log')
    expect(ev.text).toBe('this is not json')
  })

  it('degrades a truncated JSON object to a log event', () => {
    const ev = opencodeLineToEvent('{"type":"text","part":{')
    expect(ev.type).toBe('log')
  })
})

describe('opencode/result.collectOpencodeAnswerParts', () => {
  it('dedupes by part id keeping the last text, preserving order', () => {
    const events = [
      frameEvent({ type: 'text', part: { id: 'b', text: 'first' } }),
      frameEvent({ type: 'text', part: { id: 'b', text: 'first (final)' } }),
      frameEvent({ type: 'text', part: { id: 'c', text: 'second' } }),
    ]
    expect(collectOpencodeAnswerParts(events)).toEqual([
      'first (final)',
      'second',
    ])
  })

  it('ignores blank text parts', () => {
    const events = [
      frameEvent({ type: 'text', part: { id: 'b', text: '   ' } }),
      frameEvent({ type: 'text', part: { id: 'c', text: 'real' } }),
    ]
    expect(collectOpencodeAnswerParts(events)).toEqual(['real'])
  })
})

describe('opencode/result.lastStepFinishPart', () => {
  it('returns the last step_finish part', () => {
    const events = [
      frameEvent({ type: 'step_finish', part: { reason: 'stop' } }),
      frameEvent({ type: 'step_finish', part: { reason: 'length' } }),
    ]
    expect(lastStepFinishPart(events)?.reason).toBe('length')
  })

  it('returns null when there is no finish frame', () => {
    const events = [frameEvent({ type: 'text', part: { id: 'b', text: 'x' } })]
    expect(lastStepFinishPart(events)).toBeNull()
  })
})

describe('opencode/result.resolveOpencodeAnswer (terminal folding)', () => {
  const finished = [
    frameEvent({ type: 'step_start', part: {} }),
    frameEvent({ type: 'text', part: { id: 'b', text: 'the answer' } }),
    frameEvent({ type: 'step_finish', part: { reason: 'stop' } }),
  ]

  it('completes on a stop reason with non-blank text', () => {
    const r = resolveOpencodeAnswer(finished, okTerm)
    expect(r).toEqual({ text: 'the answer', stopReason: 'completed' })
  })

  it('joins multiple parts with newlines', () => {
    const r = resolveOpencodeAnswer(
      [
        frameEvent({ type: 'text', part: { id: 'b', text: 'line one' } }),
        frameEvent({ type: 'text', part: { id: 'c', text: 'line two' } }),
        frameEvent({ type: 'step_finish', part: { reason: 'stop' } }),
      ],
      okTerm,
    )
    expect(r.text).toBe('line one\nline two')
    expect(r.stopReason).toBe('completed')
  })

  it('treats a finish with no text as an error', () => {
    const r = resolveOpencodeAnswer(
      [frameEvent({ type: 'step_finish', part: { reason: 'stop' } })],
      okTerm,
    )
    expect(r.stopReason).toBe('error')
    expect(r.errorMessage).toMatch(/without an answer/)
    expect(r.diagnostic).toMatch(/no-answer/)
  })

  it('maps reason length to max-tokens keeping the partial', () => {
    const r = resolveOpencodeAnswer(
      [
        frameEvent({ type: 'text', part: { id: 'b', text: 'partial…' } }),
        frameEvent({ type: 'step_finish', part: { reason: 'length' } }),
      ],
      okTerm,
    )
    expect(r.stopReason).toBe('max-tokens')
    expect(r.text).toBe('partial…')
  })

  it('maps reason content-filter to refusal', () => {
    const r = resolveOpencodeAnswer(
      [frameEvent({ type: 'step_finish', part: { reason: 'content-filter' } })],
      okTerm,
    )
    expect(r.stopReason).toBe('refusal')
  })

  it('maps reason error to error with the stderr tail', () => {
    const r = resolveOpencodeAnswer(
      [
        frameEvent({ type: 'text', part: { id: 'b', text: 'partial' } }),
        frameEvent({ type: 'step_finish', part: { reason: 'error' } }),
      ],
      { ...okTerm, stderrTail: 'opencode: boom' },
    )
    expect(r.stopReason).toBe('error')
    expect(r.errorMessage).toBe('opencode: boom')
    expect(r.text).toBe('')
  })

  it('surfaces a non-zero exit without a finish as an error', () => {
    const r = resolveOpencodeAnswer(
      [frameEvent({ type: 'step_start', part: {} })],
      { exitCode: 3, signal: null, stderrTail: 'opencode: not authenticated' },
    )
    expect(r.stopReason).toBe('error')
    expect(r.errorMessage).toMatch(/not authenticated/)
    expect(r.diagnostic).toMatch(/exit-without-finish/)
  })

  it('falls back to the exit code when stderr is empty', () => {
    const r = resolveOpencodeAnswer([], { exitCode: 7, signal: null, stderrTail: '' })
    expect(r.errorMessage).toMatch(/exited with code 7/)
  })

  it('classifies signal termination without a finish as an error', () => {
    const r = resolveOpencodeAnswer([], { exitCode: null, signal: 'SIGKILL', stderrTail: '' })
    expect(r.stopReason).toBe('error')
    expect(r.errorMessage).toMatch(/SIGKILL/)
  })

  it('is lenient when the process exits cleanly with text but no finish', () => {
    const r = resolveOpencodeAnswer(
      [frameEvent({ type: 'text', part: { id: 'b', text: 'answer' } })],
      okTerm,
    )
    expect(r).toEqual({ text: 'answer', stopReason: 'completed' })
  })

  it('errors on completely empty output', () => {
    const r = resolveOpencodeAnswer([], okTerm)
    expect(r.stopReason).toBe('error')
    expect(r.diagnostic).toMatch(/no-output/)
  })
})
