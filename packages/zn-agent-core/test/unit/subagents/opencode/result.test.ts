import { describe, it, expect } from 'vitest'
import type { SubagentEvent } from '../../../../src/compat/subagents/registry.js'
import {
  opencodeLineToEvents,
  collectOpencodeAnswerParts,
  lastStepFinishPart,
  resolveOpencodeAnswer,
} from '../../../../src/compat/subagents/opencode/result.js'

const okTerm = { exitCode: 0, signal: null, stderrTail: '' }

function frameEvents(obj: unknown): SubagentEvent[] {
  return opencodeLineToEvents(JSON.stringify(obj))
}

/** Convenience for single-event frames (everything except `tool_use`). */
function frameEvent(obj: unknown): SubagentEvent {
  return frameEvents(obj)[0]!
}

describe('opencode/result.opencodeLineToEvents (bg-vocabulary projection)', () => {
  it('maps a text frame onto agentMessage carrying part.text', () => {
    const ev = opencodeLineToEvents(
      JSON.stringify({ type: 'text', part: { id: 'a', type: 'text', text: 'hi' } }),
    )[0]!
    expect(ev.type).toBe('agentMessage')
    expect(ev.text).toBe('hi')
  })

  it('projects step_start / step_finish onto turnStarted / turnCompleted with raw fidelity', () => {
    const ss = opencodeLineToEvents(JSON.stringify({ type: 'step_start', part: {} }))[0]!
    const sf = opencodeLineToEvents(
      JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }),
    )[0]!
    expect(ss.type).toBe('turnStarted')
    expect(sf.type).toBe('turnCompleted')
    expect((sf.raw as { part: { reason: string } }).part.reason).toBe('stop')
  })

  it('fans a completed tool_use frame into a toolCall + toolResult pair', () => {
    const events = opencodeLineToEvents(
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          callID: 'call-1',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'whoami' }, output: 'me\n' },
        },
      }),
    )
    expect(events.map((e) => e.type)).toEqual(['toolCall', 'toolResult'])
    // TaskDrawer reads raw.id / raw.name / raw.input for tool_use and
    // raw.tool_use_id for tool_result — the pair must carry that shape.
    expect(events[0]!.raw).toEqual({ id: 'call-1', name: 'bash', input: { command: 'whoami' } })
    expect(events[1]!.raw).toEqual({ tool_use_id: 'call-1' })
  })

  it('emits only a toolCall for a non-terminal tool frame', () => {
    const events = opencodeLineToEvents(
      JSON.stringify({
        type: 'tool_use',
        part: { type: 'tool', callID: 'call-2', tool: 'bash', state: { status: 'running' } },
      }),
    )
    expect(events.map((e) => e.type)).toEqual(['toolCall'])
  })

  it('maps a reasoning frame onto commentary', () => {
    const ev = opencodeLineToEvents(
      JSON.stringify({ type: 'reasoning', part: { type: 'reasoning', text: 'thinking…' } }),
    )[0]!
    expect(ev.type).toBe('commentary')
    expect(ev.text).toBe('thinking…')
  })

  it('forwards an unknown frame type verbatim', () => {
    const ev = opencodeLineToEvents(JSON.stringify({ type: 'patch', foo: 1 }))[0]!
    expect(ev.type).toBe('patch')
    expect((ev.raw as { foo: number }).foo).toBe(1)
  })

  it('degrades a non-JSON line to a log event (never throws)', () => {
    const ev = opencodeLineToEvents('this is not json')[0]!
    expect(ev.type).toBe('log')
    expect(ev.text).toBe('this is not json')
  })

  it('degrades a truncated JSON object to a log event', () => {
    const ev = opencodeLineToEvents('{"type":"text","part":{')[0]!
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
