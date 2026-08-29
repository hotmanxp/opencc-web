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

  it('getHistoryAfterForSid: lastEventId===undefined returns lifecycle events but drops streaming (EventSource reopen race fix + duplicate-reply fix)', () => {
    // 回归 1:2026-08-27 用户报告 "点 + 新建会话后第一条消息收不到回复,刷新才行"。
    // 旧实现 lastEventId===undefined → [];HTML 规范下新 EventSource 实例
    // (URL 带新 sid) 永远不带 Last-Event-ID,导致重连 gap 内 emit 的 runtime.*
    // 永远没人收。修法:无 lastEventId 时也回放该 sid 的 lifecycle events。
    //
    // 回归 2:2026-08-28 sess-1787931317204-8d39z9ou 4 气泡 bug — reload 时
    // SSE history replay 推 runtime.thinking/runtime.delta/runtime.tool_call/
    // runtime.tool_result,前端 upsertStreamBlock 把这些事件写入 messages 数组
    // 形成额外 (thinking + text) 副本,与 transcript load 内容重复。streaming
    // events 已经持久化在 transcript jsonl 里,replay 时不重复推,client 走
    // loadTranscript 拿回完整内容。
    bus.emit({ type: 'runtime.started', sessionId: 'sess-1', turnIndex: 0, apiRequestCount: 1, contextTokens: 0 })
    bus.emit({ type: 'runtime.thinking', sessionId: 'sess-1', turnIndex: 0, thinking: 'thinking text' })
    bus.emit({ type: 'runtime.delta', sessionId: 'sess-1', turnIndex: 0, delta: 'hi' })
    bus.emit({ type: 'runtime.done', sessionId: 'sess-1', turnIndex: 0 })
    bus.emit({ type: 'cwd.changed', sessionId: 'sess-2', cwd: '/x', updatedAt: 1 })
    const replayed = bus.getHistoryAfterForSid(undefined, 'sess-1')
    // lifecycle (runtime.started/runtime.done) 保留,streaming (runtime.thinking/
    // runtime.delta) 过滤掉
    expect(replayed).toHaveLength(2)
    expect(replayed.map((e) => e.type)).toEqual(['runtime.started', 'runtime.done'])
    expect(replayed.every((e) => (e as { sessionId?: string }).sessionId === 'sess-1')).toBe(true)
  })

  it('getHistoryAfterForSid: lastEventId 有值时续读保留 streaming events (EventSource 重连续读)', () => {
    // EventSource 同 URL 自动重连带 Last-Event-ID,server 从该点之后续推。
    // streaming events (runtime.thinking/runtime.delta) 必须继续 replay,
    // 否则 client 端 upsertStreamBlock 找不到续传 delta,stream 断流。
    //
    // 步骤: 先 emit lifecycle event (runtime.started) 拿其 eventId 作为已知断点,
    // 然后 emit 一个 streaming event 后续传。续读时该 streaming event 必须保留。
    bus.emit({ type: 'runtime.started', sessionId: 'sess-1', turnIndex: 0, apiRequestCount: 1, contextTokens: 0 })
    const opened = bus.getHistoryAfterForSid(undefined, 'sess-1')
    expect(opened).toHaveLength(1)
    const knownId = opened[0].eventId
    bus.emit({ type: 'runtime.thinking', sessionId: 'sess-1', turnIndex: 0, thinking: 'second' })
    bus.emit({ type: 'runtime.delta', sessionId: 'sess-1', turnIndex: 0, delta: 'text' })
    const continued = bus.getHistoryAfterForSid(knownId, 'sess-1')
    // 续读时 streaming events 不被过滤
    expect(continued).toHaveLength(2)
    expect(continued.map((e) => e.type)).toEqual(['runtime.thinking', 'runtime.delta'])
  })

  it('getHistoryAfterForSid: lastEventId 有值但找不到断点 → 回退到全量 (含 streaming events)', () => {
    // EventSource 重连时 lastEventId 已被 server 端 history 截断 (CAPACITY=256),
    // 找不到时退到全量,client 端 upsertStreamBlock seq 守卫 (lastSeqBySession)
    // 会去重已处理过的事件;但 streaming events 必须保留以避免断流。
    bus.emit({ type: 'runtime.thinking', sessionId: 'sess-1', turnIndex: 0, thinking: 'a' })
    bus.emit({ type: 'runtime.thinking', sessionId: 'sess-1', turnIndex: 0, thinking: 'b' })
    const replayed = bus.getHistoryAfterForSid('evt_unknown_breakpoint', 'sess-1')
    expect(replayed).toHaveLength(2)
    expect(replayed.every((e) => e.type === 'runtime.thinking')).toBe(true)
  })

  it('getHistoryAfterForSidWithTopics: lastEventId===undefined 也过滤 streaming events', () => {
    bus.emit({ type: 'runtime.started', sessionId: 'sess-1', turnIndex: 0, apiRequestCount: 1, contextTokens: 0 })
    bus.emit({ type: 'runtime.delta', sessionId: 'sess-1', turnIndex: 0, delta: 'hi' })
    bus.emit({ type: 'runtime.done', sessionId: 'sess-1', turnIndex: 0 })
    const replayed = bus.getHistoryAfterForSidWithTopics(undefined, 'sess-1', ['runtime'])
    expect(replayed.map((e) => e.type)).toEqual(['runtime.started', 'runtime.done'])
    expect(replayed.some((e) => e.type === 'runtime.delta')).toBe(false)
  })

  it('getHistoryAfter: lastEventId===undefined returns full history (EventSource reopen race fix)', () => {
    bus.emit({ type: 'queue.changed', sessionId: 'sess-1', running: true, queueLength: 0, pending: [] })
    bus.emit({ type: 'queue.changed', sessionId: 'sess-2', running: false, queueLength: 0, pending: [] })
    const replayed = bus.getHistoryAfter(undefined)
    expect(replayed.length).toBeGreaterThanOrEqual(2)
  })
})
