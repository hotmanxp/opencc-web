import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ServerEventBus, isGlobalEvent } from '../../../services/eventBus.js'
import { ServerEvent as ServerEventSchema } from '../../../../shared/events.js'
import type { ServerEvent } from '../../../../shared/events.js'

// 与前端 useEventStream.ts 的 GLOBAL_ONLY_TOPICS 逐项对应。改一边必须改
// 另一边 —— 「无会话页面收哪些事件」是前后端契约,不是单端实现细节。
// queue / agent_task / state.* 刻意不在其中:它们在 isGlobalEvent 里是 false。
const GLOBAL_ONLY_TOPICS = [
  'system', 'instance', 'task_factory', 'skills',
  'app_update', 'command', 'session', 'job',
]

// 从 zod discriminatedUnion 里枚举出所有真实存在的 event type,避免手抄
// 清单漏项 —— 新增事件类型时这条断言会自动把它纳进来。
function allEventTypes(): string[] {
  return (ServerEventSchema as unknown as {
    options: Array<{ shape: { type: { value: string } } }>
  }).options.map((o) => o.shape.type.value)
}


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

  it('topicMatches: 无会话订阅依赖的全局 group (2026-09-30 /instances 不刷新修复)', () => {
    // 前端 GLOBAL_ONLY_TOPICS 逐项对应这里。少登记一个,对应的全局事件
    // 就会在无会话页面(实例管理 / 管理 / 仪表盘)静默收不到。
    expect(ServerEventBus.topicMatches('instance.changed', ['instance'])).toBe(true)
    expect(ServerEventBus.topicMatches('task_factory', ['task_factory'])).toBe(true)
    expect(ServerEventBus.topicMatches('skills.changed', ['skills'])).toBe(true)
    expect(ServerEventBus.topicMatches('command.run', ['command'])).toBe(true)
    expect(ServerEventBus.topicMatches('command.done', ['command'])).toBe(true)
    expect(ServerEventBus.topicMatches('app.update.complete', ['app_update'])).toBe(true)
    expect(ServerEventBus.topicMatches('app.update.failed', ['app_update'])).toBe(true)
    // 'system' group 扩成了 GLOBAL_TOPIC_SYSTEM,覆盖 restart/stopping
    expect(ServerEventBus.topicMatches('system.restarting', ['system'])).toBe(true)
    expect(ServerEventBus.topicMatches('system.stopping', ['system'])).toBe(true)
  })

  it('topicMatches: 全局 group 不误收会话级事件 (串台防护)', () => {
    // 无会话时最怕的是把别的会话的流式输出 / 待确认卡片收进来。
    for (const topic of ['system', 'instance', 'task_factory', 'skills', 'app_update', 'command']) {
      expect(ServerEventBus.topicMatches('runtime.delta', [topic])).toBe(false)
      expect(ServerEventBus.topicMatches('prompt.ask', [topic])).toBe(false)
      expect(ServerEventBus.topicMatches('prompt.approve', [topic])).toBe(false)
      expect(ServerEventBus.topicMatches('cwd.changed', [topic])).toBe(false)
      // queue / agent_task 是 sid-scoped,任何全局 group 都不能放行
      expect(ServerEventBus.topicMatches('queue.changed', [topic])).toBe(false)
      expect(ServerEventBus.topicMatches('agent_task.changed', [topic])).toBe(false)
    }
  })

  it('topicMatches: 前端 GLOBAL_ONLY_TOPICS 整组只命中全局事件', () => {
    // 应当命中:实例管理页 / 看板 / 顶栏连接态真正依赖的那批
    expect(ServerEventBus.topicMatches('instance.changed', GLOBAL_ONLY_TOPICS)).toBe(true)
    expect(ServerEventBus.topicMatches('task_factory', GLOBAL_ONLY_TOPICS)).toBe(true)
    expect(ServerEventBus.topicMatches('server.connected', GLOBAL_ONLY_TOPICS)).toBe(true)
    // 绝不能命中:会让 applyPromptAsk 串台的会话级事件
    expect(ServerEventBus.topicMatches('prompt.ask', GLOBAL_ONLY_TOPICS)).toBe(false)
    expect(ServerEventBus.topicMatches('runtime.delta', GLOBAL_ONLY_TOPICS)).toBe(false)
  })

  it('漂移守护: 每个全局事件 type 都被 GLOBAL_ONLY_TOPICS 覆盖', () => {
    // 契约:isGlobalEvent() === true 的 type,必须能被 topics 白名单命中 ——
    // 否则「无活跃会话」的页面(实例管理 / 管理 / 仪表盘)收不到它, 而这些
    // 页面恰恰是最需要全局事件的。isGlobalEvent 是 switch, GLOBAL_TOPIC_*
    // 是若干 Set, 两份清单靠人力同步必然漂移, 这里逐 type 断言兜住。
    //
    // 新增全局事件类型时:isGlobalEvent 加 case → 这里会红 → 补对应
    // GLOBAL_TOPIC_* Set + 前端 GLOBAL_ONLY_TOPICS 列表。
    const types = allEventTypes()
    expect(types.length).toBeGreaterThan(20) // 枚举没取到就说明 schema 结构变了
    const uncovered = types.filter((type) => {
      const isGlobal = isGlobalEvent({ type } as unknown as ServerEvent)
      return isGlobal && !ServerEventBus.topicMatches(type, [...GLOBAL_ONLY_TOPICS])
    })
    expect(
      uncovered,
      `这些全局事件没有被 topics 白名单覆盖,无会话页面收不到: ${uncovered.join(', ')}`,
    ).toEqual([])
  })

  it('漂移守护: GLOBAL_ONLY_TOPICS 不命中任何非全局事件', () => {
    // 反向断言:白名单只能放行 isGlobalEvent === true 的 type。收窄 isGlobalEvent
    // 不会让某条白名单变成串台后门。
    const leaking = allEventTypes().filter(
      (type) =>
        !isGlobalEvent({ type } as unknown as ServerEvent) &&
        ServerEventBus.topicMatches(type, [...GLOBAL_ONLY_TOPICS]),
    )
    expect(
      leaking,
      `这些非全局事件被白名单放行了,会把别的会话事件串到无会话页面: ${leaking.join(', ')}`,
    ).toEqual([])
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
