import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ServerEventBus } from '../../../services/eventBus.js'

describe('ServerEventBus topic filter', () => {
  let bus: ServerEventBus

  beforeEach(() => {
    bus = new ServerEventBus()
  })

  it('topicMatches: state group covers 4 state.* types', () => {
    expect(ServerEventBus.topicMatches('cwd.changed', ['state'])).toBe(true)
    expect(ServerEventBus.topicMatches('bash_task.changed', ['state'])).toBe(true)
    expect(ServerEventBus.topicMatches('v2_task.changed', ['state'])).toBe(true)
    expect(ServerEventBus.topicMatches('agent_task.changed', ['state'])).toBe(true)
    expect(ServerEventBus.topicMatches('runtime.delta', ['state'])).toBe(false)
  })

  it('topicMatches: specific topic only matches one type', () => {
    expect(ServerEventBus.topicMatches('bash_task.changed', ['bash'])).toBe(true)
    expect(ServerEventBus.topicMatches('cwd.changed', ['bash'])).toBe(false)
  })

  it('topicMatches: legacy group names', () => {
    expect(ServerEventBus.topicMatches('runtime.delta', ['runtime'])).toBe(true)
    expect(ServerEventBus.topicMatches('session.created', ['session'])).toBe(true)
    expect(ServerEventBus.topicMatches('job.started', ['job'])).toBe(true)
    expect(ServerEventBus.topicMatches('prompt.ask', ['prompt'])).toBe(true)
    expect(ServerEventBus.topicMatches('server.connected', ['system'])).toBe(true)
  })

  it('subscribeTopics filters events by topic', () => {
    const cb = vi.fn()
    const unsub = bus.subscribeTopics('sess-1', ['bash'], cb)
    bus.emit({ type: 'bash_task.changed', sessionId: 'sess-1', task: {} })
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-1', cwd: '/', updatedAt: 1 })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].type).toBe('bash_task.changed')
    unsub()
  })

  it('subscribeTopics with sid filter drops mismatched sid', () => {
    const cb = vi.fn()
    bus.subscribeTopics('sess-1', ['state'], cb)
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-2', cwd: '/', updatedAt: 1 })
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-1', cwd: '/a', updatedAt: 2 })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].sessionId).toBe('sess-1')
  })

  it('getHistoryAfterForSidWithTopics filters replay', () => {
    // getHistoryAfterForSid semantics: lastEventId===undefined → [];
    // unknown lastEventId → full slice. Use an unknown id so the topic filter
    // actually has a non-empty slice to filter on.
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-1', cwd: '/a', updatedAt: 1 })
    bus.emit({ type: 'bash_task.changed', sessionId: 'sess-1', task: {} })
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-1', cwd: '/b', updatedAt: 2 })
    const filtered = bus.getHistoryAfterForSidWithTopics('evt_unknown', 'sess-1', ['cwd'])
    expect(filtered).toHaveLength(2)
    expect(filtered.every((e) => e.type === 'cwd.changed')).toBe(true)
  })
})
