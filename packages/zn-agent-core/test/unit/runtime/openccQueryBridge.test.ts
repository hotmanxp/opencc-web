import { describe, expect, it } from 'vitest'
import {
  runViaOpenccQuery,
  translateToolCallbackToServerEvent,
} from '../../../src/compat/runtime/openccQueryBridge.js'

function makeOpts(overrides: Partial<any> = {}): any {
  return {
    prompt: { role: 'user', content: 'hello' },
    cwd: '/tmp',
    model: 'm',
    tools: [],
    sessionId: 's1',
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

describe('runViaOpenccQuery', () => {
  it('emits runtime.aborted if abortSignal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort('test cancel')
    const events: any[] = []
    for await (const ev of runViaOpenccQuery(makeOpts({ abortSignal: ac.signal }), {})) {
      events.push(ev)
    }
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('runtime.aborted')
    expect(events[0].reason).toBe('test cancel')
  })

  it('does not throw when config is empty', async () => {
    const ac = new AbortController()
    ac.abort('stop before import')
    const events: any[] = []
    for await (const ev of runViaOpenccQuery(makeOpts({ abortSignal: ac.signal }), {})) {
      events.push(ev)
    }
    expect(events.length).toBeGreaterThan(0)
  })
})

describe('translateToolCallbackToServerEvent — ask_pending → prompt.ask', () => {
  // Regression (Bug B): the bridge's onYield used to emit
  // `{type:'tool_use:ask_pending', ...}` directly to the eventBus.
  // eventBus forwards the event to SSE as-is, but the frontend's
  // useEventStream only dispatches `prompt.ask` (useEventStream.ts:56,
  // eventSource.ts:35), so the QuestionCard never rendered. The fix is
  // a translation step before bus.emit.

  it('translates tool_use:ask_pending to prompt.ask', () => {
    const out = translateToolCallbackToServerEvent(
      {
        type: 'tool_use:ask_pending',
        id: 'tu-1',
        toolUseId: 'tu-1',
        questions: [{ question: 'q1', header: 'h', options: [] }],
        metadata: { source: 'AskUserQuestion' },
      },
      'sess-1',
    )
    expect(out).toEqual({
      type: 'prompt.ask',
      sessionId: 'sess-1',
      toolUseId: 'tu-1',
      questions: [{ question: 'q1', header: 'h', options: [] }],
      metadata: { source: 'AskUserQuestion' },
    })
  })

  it('falls back to ev.id when toolUseId is missing', () => {
    const out = translateToolCallbackToServerEvent(
      { type: 'tool_use:ask_pending', id: 'tu-2', questions: [] },
      'sess-2',
    )
    expect(out?.toolUseId).toBe('tu-2')
  })

  it('uses empty string when neither id nor toolUseId is set', () => {
    const out = translateToolCallbackToServerEvent(
      { type: 'tool_use:ask_pending', questions: [] },
      'sess-3',
    )
    expect(out?.toolUseId).toBe('')
  })

  it('omits metadata when not provided', () => {
    const out = translateToolCallbackToServerEvent(
      { type: 'tool_use:ask_pending', toolUseId: 'tu-4', questions: [] },
      'sess-4',
    )
    expect(out).not.toHaveProperty('metadata')
  })

  it('returns undefined for unknown event types (caller forwards raw)', () => {
    expect(
      translateToolCallbackToServerEvent(
        { type: 'tool_use:done', toolUseId: 'tu-5', output: 'ok' },
        'sess-5',
      ),
    ).toBeUndefined()
  })

  it('returns undefined for events that are not ask_pending', () => {
    // Defensive: only ask_pending is currently routed via onYield;
    // any other RuntimeEvent flowing through the bridge's onYield
    // bypass must NOT be silently re-typed as prompt.ask.
    for (const type of [
      'tool_use:start',
      'tool_use:done',
      'tool_use:error',
      'tool_use:invalid',
      'tool_use:denied',
      'message_start',
      'content_block_stop',
    ]) {
      expect(
        translateToolCallbackToServerEvent({ type }, 'sess-x'),
      ).toBeUndefined()
    }
  })
})
