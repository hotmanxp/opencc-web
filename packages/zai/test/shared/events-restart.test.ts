import { describe, expect, it } from 'vitest'
import { ServerEvent } from '../../src/shared/events.js'

describe('ServerEvent union', () => {
  it('accepts system.restarting payload', () => {
    const e = ServerEvent.parse({
      type: 'system.restarting', eventId: 'e1', ts: Date.now(),
      reason: 'user_action', deadlineMs: Date.now() + 5000,
    })
    expect(e.type).toBe('system.restarting')
  })
})
