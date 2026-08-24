import { describe, expect, it } from 'vitest'
import { RuntimeEvent, ServerEvent } from '../../src/shared/events.js'

describe('RuntimeEvent union includes subagent events', () => {
  it('parses subagent.start', () => {
    const ok = RuntimeEvent.parse({
      eventId: 'e1', ts: 0, seq: 1,
      type: 'subagent.start', sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true,
    })
    expect(ok.type).toBe('subagent.start')
  })

  it('parses subagent.end with stopReason', () => {
    const ok = RuntimeEvent.parse({
      eventId: 'e1', ts: 0, seq: 1,
      type: 'subagent.end', sessionId: 's1', runId: 'r1',
      provider: 'spawn', id: 'x', local: true, stopReason: 'completed',
    })
    expect(ok.type).toBe('subagent.end')
  })

  // subagent.changed lives in StateEvent (via ServerEvent), not RuntimeEvent.
  // Marking deprecated in StateEvent does not add it to RuntimeEvent.
  it('still parses legacy subagent.changed (deprecated) via ServerEvent', () => {
    const ok = ServerEvent.parse({
      eventId: 'e1', ts: 0, seq: 1,
      type: 'subagent.changed', sessionId: 's1', taskId: 'r1',
      description: 'd', status: 'running', action: 'start',
    })
    expect(ok.type).toBe('subagent.changed')
  })
})
