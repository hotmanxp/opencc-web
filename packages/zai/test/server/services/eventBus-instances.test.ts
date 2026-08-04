import { describe, expect, it } from 'vitest'
import { ServerEventBus } from '../../../src/server/services/eventBus.js'
import { ServerEvent } from '../../../src/shared/events.js'

describe('eventBus instance.changed', () => {
  it('treats instance.changed as a global event (delivers under any wantedSid)', () => {
    const bus = new ServerEventBus()
    const got: string[] = []
    bus.subscribeScoped('some-session', (e) => got.push(e.type))
    bus.emit({
      type: 'instance.changed',
      instanceId: 'inst_1',
      state: 'running',
      port: 9202,
      pid: 42,
      lastHeartbeatAt: null,
    } as never)
    expect(got).toEqual(['instance.changed'])
  })

  it('parses the new event variant against the ServerEvent zod schema', () => {
    const parsed = ServerEvent.parse({
      type: 'instance.changed',
      eventId: 'evt_x',
      ts: 1700000000000,
      instanceId: 'inst_1',
      state: 'starting',
      port: null,
      pid: 999,
      lastHeartbeatAt: null,
    })
    expect(parsed.type).toBe('instance.changed')
  })
})
