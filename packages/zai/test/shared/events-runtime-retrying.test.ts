import { describe, expect, it } from 'vitest'
import { ServerEvent } from '../../src/shared/events.js'

describe('ServerEvent — runtime.retrying variant', () => {
  it('parses a valid runtime.retrying event', () => {
    const ev = {
      type: 'runtime.retrying',
      eventId: 'evt-1',
      sessionId: 'sess-1',
      ts: 1000,
      seq: 1,
      turnIndex: 0,
      attempt: 1,
      delayMs: 500,
      nextAttemptAtMs: 1500,
      category: 'llm_provider_overloaded',
    }
    const parsed = ServerEvent.parse(ev)
    expect(parsed).toMatchObject({
      type: 'runtime.retrying',
      attempt: 1,
      delayMs: 500,
      nextAttemptAtMs: 1500,
      category: 'llm_provider_overloaded',
    })
  })

  it('accepts llm_provider_server and llm_provider_rate_limit categories', () => {
    for (const category of ['llm_provider_overloaded', 'llm_provider_server', 'llm_provider_rate_limit']) {
      const ev = {
        type: 'runtime.retrying',
        eventId: 'evt-1',
        sessionId: 'sess-1',
        ts: 1000,
        seq: 2,
        turnIndex: 0,
        attempt: 2,
        delayMs: 1000,
        nextAttemptAtMs: 2000,
        category,
      }
      expect(() => ServerEvent.parse(ev)).not.toThrow()
    }
  })

  it('rejects when required field "attempt" is missing', () => {
    const ev = {
      type: 'runtime.retrying',
      eventId: 'evt-1',
      sessionId: 'sess-1',
      ts: 1000,
      seq: 3,
      turnIndex: 0,
      delayMs: 500,
      nextAttemptAtMs: 1500,
      category: 'llm_provider_overloaded',
    }
    expect(() => ServerEvent.parse(ev)).toThrow(/attempt/i)
  })
})