import { describe, expect, test } from 'vitest'
import { ServerEvent } from './events.js'

describe('ServerEvent schema', () => {
  test('accepts runtime.delta', () => {
    const event = {
      type: 'runtime.delta',
      eventId: 'evt_1',
      ts: 1000,
      seq: 42,
      sessionId: 's_1',
      turnIndex: 0,
      delta: 'hello',
    }
    expect(() => ServerEvent.parse(event)).not.toThrow()
  })

  test('accepts session.created', () => {
    const event = {
      type: 'session.created',
      eventId: 'evt_2',
      ts: 1000,
      seq: 43,
      sessionId: 's_2',
      title: 'New chat',
      cwd: '/tmp',
    }
    expect(() => ServerEvent.parse(event)).not.toThrow()
  })

  test('accepts prompt.ask', () => {
    const event = {
      type: 'prompt.ask',
      eventId: 'evt_3',
      ts: 1000,
      seq: 44,
      sessionId: 's_3',
      toolUseId: 'tu_1',
      questions: [
        { question: 'Pick one', header: 'Choose', options: [{ label: 'A' }] },
      ],
    }
    expect(() => ServerEvent.parse(event)).not.toThrow()
  })

  test('accepts prompt.approve (filePath variant)', () => {
    // The filePath simplification: prompt.approve only carries the path;
    // the body is fetched by the drawer via /api/agent/approve/file.
    const evt = {
      type: 'prompt.approve',
      eventId: 'evt_3',
      ts: 1000,
      seq: 45,
      sessionId: 's_3',
      toolUseId: 'tu_a',
      title: 'Review spec',
      summary: 'Loaded from disk',
      filePath: 'docs/plan.md',
    }
    expect(() => ServerEvent.parse(evt)).not.toThrow()
  })

  test('accepts server.connected', () => {
    const event = {
      type: 'server.connected',
      eventId: 'evt_4',
      ts: 1000,
      seq: 46,
      sessionId: null,
    }
    expect(() => ServerEvent.parse(event)).not.toThrow()
  })

  test('rejects missing seq', () => {
    const event = {
      type: 'runtime.delta',
      eventId: 'evt_1',
      ts: 1000,
      sessionId: 's_1',
      turnIndex: 0,
      delta: 'hello',
    }
    expect(() => ServerEvent.parse(event)).toThrow(/seq/)
  })

  test('accepts stream/error frame', () => {
    const event = {
      type: 'stream/error',
      eventId: 'evt_err',
      ts: 1000,
      seq: 47,
      error: { code: 'internal', message: 'boom', details: {} },
    }
    const parsed = ServerEvent.parse(event)
    expect(parsed.type).toBe('stream/error')
    expect(parsed).toMatchObject({ error: { code: 'internal', message: 'boom' } })
  })

  test('rejects unknown error code', () => {
    const event = {
      type: 'stream/error',
      eventId: 'evt_err2',
      ts: 1000,
      seq: 48,
      error: { code: 'nope', message: 'x' },
    }
    expect(() => ServerEvent.parse(event)).toThrow(/code/i)
  })

  test('accepts session/projection frame', () => {
    const event = {
      type: 'session/projection',
      eventId: 'evt_proj',
      ts: 1000,
      seq: 49,
      sessionId: 's_1',
      key: 'title',
      value: 'My Session',
    }
    const parsed = ServerEvent.parse(event)
    expect(parsed.type).toBe('session/projection')
    expect(parsed).toMatchObject({ sessionId: 's_1', key: 'title', value: 'My Session' })
  })

  test('rejects unknown type', () => {
    const event = {
      type: 'made.up',
      eventId: 'evt_5',
      ts: 1000,
    }
    expect(() => ServerEvent.parse(event)).toThrow()
  })

  test('rejects missing eventId', () => {
    const event = {
      type: 'runtime.done',
      ts: 1000,
      seq: 50,
      sessionId: 's_1',
      turnIndex: 0,
    }
    expect(() => ServerEvent.parse(event)).toThrow()
  })

  test('round-trips through JSON', () => {
    const event = {
      type: 'runtime.done',
      eventId: 'evt_6',
      ts: 1000,
      seq: 51,
      sessionId: 's_1',
      turnIndex: 0,
      usage: { input: 10, output: 20 },
    }
    const json = JSON.stringify(event)
    const parsed = ServerEvent.parse(JSON.parse(json))
    expect(parsed.type).toBe('runtime.done')
  })
})
