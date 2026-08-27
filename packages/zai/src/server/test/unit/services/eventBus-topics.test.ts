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
    // unknown lastEventId → full slice. Use an unknown id so the topic filter
    // actually has a non-empty slice to filter on.
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-1', cwd: '/a', updatedAt: 1 })
    bus.emit({ type: 'bash_task.changed', sessionId: 'sess-1', task: {} })
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-1', cwd: '/b', updatedAt: 2 })
    const filtered = bus.getHistoryAfterForSidWithTopics('evt_unknown', 'sess-1', ['cwd'])
    expect(filtered).toHaveLength(2)
    expect(filtered.every((e) => e.type === 'cwd.changed')).toBe(true)
  })

  it('getHistoryAfterForSid: lastEventId===undefined returns full slice (EventSource reopen race fix)', () => {
    // 回归:2026-08-27 用户报告 "点 + 新建会话后第一条消息收不到回复,刷新才行"。
    // 旧实现 lastEventId===undefined → [];HTML 规范下新 EventSource 实例
    // (URL 带新 sid) 永远不带 Last-Event-ID,导致重连 gap 内 emit 的 runtime.*
    // 永远没人收。修法:无 lastEventId 时也回放该 sid 全部 history(<=256),
    // 客户端 applyBatch 按 eventId/seq 去重,UI 无副作用。
    bus.emit({ type: 'runtime.started', sessionId: 'sess-1', turnIndex: 0, apiRequestCount: 1, contextTokens: 0 })
    bus.emit({ type: 'runtime.delta', sessionId: 'sess-1', turnIndex: 0, delta: 'hi' })
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-2', cwd: '/x', updatedAt: 1 })
    const replayed = bus.getHistoryAfterForSid(undefined, 'sess-1')
    expect(replayed).toHaveLength(2)
    expect(replayed.every((e) => (e as { sessionId?: string }).sessionId === 'sess-1')).toBe(true)
  })

  it('getHistoryAfter: lastEventId===undefined returns full history (EventSource reopen race fix)', () => {
    bus.emit({ type: 'queue.changed', sessionId: 'sess-1', running: true, queueLength: 0, pending: [] })
    bus.emit({ type: 'queue.changed', sessionId: 'sess-2', running: false, queueLength: 0, pending: [] })
    const replayed = bus.getHistoryAfter(undefined)
    expect(replayed.length).toBeGreaterThanOrEqual(2)
  })
})
