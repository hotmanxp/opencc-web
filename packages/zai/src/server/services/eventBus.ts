import { ServerEvent } from '../../shared/events.js'

type Subscriber = (event: ServerEvent) => void

const CAPACITY = 256
let counter = 0
const nextId = () => `evt_${Date.now().toString(36)}_${(++counter).toString(36)}`

// Indexed-mapping input type: distributes ServerEvent variants by `type` discriminator
// so inline object literals narrow correctly without excess property checks rejecting
// variant-specific fields. eventId/ts remain optional (filled in by emit).
export type ServerEventInput = {
  [K in ServerEvent as K['type']]: Omit<K, 'eventId' | 'ts'> & { eventId?: string; ts?: number }
}[ServerEvent['type']]

// 哪些事件不受 sid 限制 (与具体 session 解耦, 所有 tab 都应收)
// - session.*: 自身的生命周期通知 (sidebar 需要知道)
// - system.* (server.connected / server.error / toast / branch.changed): 全局
// - job.*: job 派发是 server-side 行为, 客户端 dock 要看得见。
//   注意: job.* 仍然带 sessionId 字段, 客户端 useBackgroundTasks 收到后
//   会按 session 切分 (详见 useBackgroundTasks.belongsToCurrentSession)。
//   这里"全局"指的是不被 subscribeScoped 按 wantedSid 过滤掉 ——
//   否则 sid=null 的 job.* (无 parentSessionId 的全局任务) 会被静默丢,
//   dock 永远看不见资源刷新 / login / install 这类系统级 job。
//   修复 HRMSV3-ZN-WEBSITE#668 同根问题 (job.* 之前被认为 sid-scoped,
//   sessionId=null 的事件被静默丢弃).
//
// 显式穷举: 未来新增事件类型时, 默认会被认为"跟 session 绑定", 不会自动
// 跨 sid 转发. 想跨 sid 的新类型必须在这里显式登记 — 这是 by-design, 防止
// 误把 sid-scoped 的事件 (比如未来的 `file.changed` 带 sid) 默认全局广播.
function isGlobalEvent(event: ServerEvent): boolean {
  switch (event.type) {
    case 'server.connected':
    case 'server.error':
    case 'toast':
    case 'branch.changed':
    case 'session.created':
    case 'session.deleted':
    case 'session.renamed':
    case 'job.started':
    case 'job.progress':
    case 'job.done':
    case 'job.failed':
      return true
    default:
      return false
  }
}

// 从事件里安全读 sessionId. runtime.* / prompt.ask 必有, session.* 有, job.* 有,
// system.* 中 server.connected 有 (nullable), 其它 system.* 没有.
// 返回 string 表示属于该 sid, null 表示全局/无关, undefined 表示无法判断 (按 null 兜底)
function eventSessionId(event: ServerEvent): string | null | undefined {
  if (
    'sessionId' in event &&
    typeof (event as { sessionId?: unknown }).sessionId === 'string'
  ) {
    return (event as { sessionId: string }).sessionId
  }
  return null
}

// 内部状态事件 type 集合,作为 'state' group 简写的展开目标。
const STATE_EVENT_TYPES = new Set<string>([
  'cwd.changed',
  'bash_task.changed',
  'v2_task.changed',
  'agent_task.changed',
])

export class ServerEventBus {
  private subs = new Set<Subscriber>()
  private history: ServerEvent[] = []
  // per-sid 历史切片, 给 SSE 路由按 sid replay 用. 仅缓存有 sessionId 的事件;
  // 全局事件 (session.* / system.*) 留在全局 history, 它们不归某个 sid.
  // 容量同样按 CAPACITY 裁, 避免单 sid 长期占满内存.
  private historyBySid = new Map<string, ServerEvent[]>()

  emit(event: ServerEventInput) {
    const full: ServerEvent = {
      ...event,
      eventId: event.eventId ?? nextId(),
      ts: event.ts ?? Date.now(),
    } as ServerEvent
    this.history.push(full)
    if (this.history.length > CAPACITY) this.history.shift()
    // 写 per-sid 切片 (仅当 event 带明确的 string sessionId)
    const sid = eventSessionId(full)
    if (typeof sid === 'string') {
      const arr = this.historyBySid.get(sid) ?? []
      arr.push(full)
      if (arr.length > CAPACITY) arr.shift()
      this.historyBySid.set(sid, arr)
    }
    for (const sub of this.subs) {
      try {
        sub(full)
      } catch (err) {
        console.error('[eventBus] subscriber threw', err)
      }
    }
  }

  getHistoryAfter(lastEventId?: string): ServerEvent[] {
    if (lastEventId === undefined) return []
    const idx = this.history.findIndex((e) => e.eventId === lastEventId)
    if (idx < 0) return [...this.history]
    return this.history.slice(idx + 1)
  }

  // 仅返回属于该 sid 的事件历史 (Last-Event-ID 续读用). 不包含 session.* /
  // system.* 等全局事件 — 那些由 EventSource 在 client 端从 store 同步,
  // SSE 渠道不需要重发 (server.connected 单独在 connect 时即时推送).
  getHistoryAfterForSid(lastEventId: string | undefined, sid: string): ServerEvent[] {
    const arr = this.historyBySid.get(sid) ?? []
    if (lastEventId === undefined) return []
    const idx = arr.findIndex((e) => e.eventId === lastEventId)
    if (idx < 0) return [...arr]
    return arr.slice(idx + 1)
  }

  /**
   * 判断 event.type 是否匹配 subscribedTopics 列表。
   *
   * 简写语义:
   * - 'state' → 4 个 state.* type 全匹配
   * - 'cwd' / 'bash' / 'v2' / 'agent_task' → 单 type 匹配
   * - 'runtime' / 'session' / 'job' / 'prompt' / 'system' → 各自已有 type group 匹配
   *
   * 未知 group/type 一律 false,白名单 semantics。
   */
  static topicMatches(type: string, topics: string[]): boolean {
    for (const t of topics) {
      if (t === 'state' && STATE_EVENT_TYPES.has(type)) return true
      if (t === 'cwd' && type === 'cwd.changed') return true
      if (t === 'bash' && type === 'bash_task.changed') return true
      if (t === 'v2' && type === 'v2_task.changed') return true
      if (t === 'agent_task' && type === 'agent_task.changed') return true
      if (t === 'runtime' && type.startsWith('runtime.')) return true
      if (t === 'session' && type.startsWith('session.')) return true
      if (t === 'job' && type.startsWith('job.')) return true
      if (t === 'prompt' && type === 'prompt.ask') return true
      if (t === 'system' && (
        type === 'server.connected' ||
        type === 'server.error' ||
        type === 'toast' ||
        type === 'branch.changed'
      )) return true
    }
    return false
  }

  getHistoryAfterForSidWithTopics(
    lastEventId: string | undefined,
    sid: string,
    topics: string[],
  ): ServerEvent[] {
    const all = this.getHistoryAfterForSid(lastEventId, sid)
    if (topics.length === 0) return all
    return all.filter((e) => ServerEventBus.topicMatches(e.type, topics))
  }

  /**
   * 带 topic 白名单 + sid 的订阅。
   * 复用 isGlobalEvent 现有逻辑:wantedSid=null 时不过滤 sid(全量),
   * 否则 sid 不匹配静默丢弃(global 事件仍透传)。
   * topic 过滤叠加:event.type 必须命中 subscribedTopics 至少一条。
   */
  subscribeTopics(
    wantedSid: string | null,
    topics: string[],
    sub: Subscriber,
  ): () => void {
    const wrapped = (event: ServerEvent) => {
      if (wantedSid != null && !isGlobalEvent(event)) {
        const sid = eventSessionId(event)
        if (sid !== wantedSid) return
      }
      if (!ServerEventBus.topicMatches(event.type, topics)) return
      sub(event)
    }
    this.subs.add(wrapped)
    return () => {
      this.subs.delete(wrapped)
    }
  }

  subscribe(sub: Subscriber): () => void {
    this.subs.add(sub)
    return () => {
      this.subs.delete(sub)
    }
  }

  // 带 sid 的订阅: 自动 filter, 只把 wantedSid 匹配或全局事件交给 callback.
  // wantedSid == null → 不过滤 (维持旧行为, 兼容旧的"全量订阅"场景).
  //
  // 设计要点: 复用同一个全局 emit 循环 (不改 emit 行为), 在订阅侧装一层
  // wrapper. 这样老代码 `eventBus.subscribe(cb)` 仍然收所有事件, 不会破坏
  // 现有调用方 (backgroundRuntime / subagentNotifier 等依赖全量).
  subscribeScoped(wantedSid: string | null, sub: Subscriber): () => void {
    const wrapped = (event: ServerEvent) => {
      if (wantedSid == null) return sub(event)
      if (isGlobalEvent(event)) return sub(event)
      const sid = eventSessionId(event)
      if (sid === wantedSid) return sub(event)
      // 不匹配: 静默丢弃. 不要 throw — 一个订阅者抛错不能影响其它订阅者.
    }
    this.subs.add(wrapped)
    return () => {
      this.subs.delete(wrapped)
    }
  }
}

export const eventBus = new ServerEventBus()