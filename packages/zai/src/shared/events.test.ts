import { describe, expect, test } from 'vitest'
import { ServerEvent } from './events.js'

describe('ServerEvent schema', () => {
  test('accepts runtime.delta', () => {
    const event = {
      type: 'runtime.delta',
      eventId: 'evt_1',
      ts: 1000,
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
      sessionId: 's_3',
      toolUseId: 'tu_1',
      questions: [
        { question: 'Pick one', header: 'Choose', options: [{ label: 'A' }] },
      ],
    }
    expect(() => ServerEvent.parse(event)).not.toThrow()
  })

  test('accepts server.connected', () => {
    const event = {
      type: 'server.connected',
      eventId: 'evt_4',
      ts: 1000,
      sessionId: null,
    }
    expect(() => ServerEvent.parse(event)).not.toThrow()
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
      sessionId: 's_1',
      turnIndex: 0,
      usage: { input: 10, output: 20 },
    }
    const json = JSON.stringify(event)
    const parsed = ServerEvent.parse(JSON.parse(json))
    expect(parsed.type).toBe('runtime.done')
  })
})
