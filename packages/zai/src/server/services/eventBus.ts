import { ServerEvent } from '../../shared/events.js'

type Subscriber = (event: ServerEvent) => void

const CAPACITY = 256
let counter = 0
const nextId = () => `evt_${Date.now().toString(36)}_${(++counter).toString(36)}`

/**
 * 本进程启动标识,随 `server.connected` 下发给客户端。
 *
 * Why: `seqCounter` 是**进程内**计数器,重启后从 0 重数。客户端的
 * `lastSeqBySession` 高水位守卫(`guardSeq <= prev` 就丢弃)若跨重启保留,
 * 重启后所有新事件都被当成旧事件丢弃 —— 页面 spinner 转、文本空白、
 * 静默无提示(重启路径不刷新页面,连 setCurrentSession 都不会触发)。
 * 客户端比对 bootId,变了就清空高水位。
 */
export const SERVER_BOOT_ID = nextId()

// Indexed-mapping input type: distributes ServerEvent variants by `type` discriminator
// so inline object literals narrow correctly without excess property checks rejecting
// variant-specific fields. eventId/ts/seq remain optional (filled in by emit).
export type ServerEventInput = {
  [K in ServerEvent as K['type']]: Omit<K, 'eventId' | 'ts' | 'seq'> & {
    eventId?: string
    ts?: number
    seq?: number
  }
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
//
// 导出供 eventBus-topics.test.ts 断言「GLOBAL_TOPIC_* 里列的每个 type 在
// 这里也是 true」—— 两份清单靠人力同步必然漂移, 新增全局事件时忘了加进
// topic group, 无会话页面就会静默收不到。
export function isGlobalEvent(event: ServerEvent): boolean {
  switch (event.type) {
    case 'server.connected':
    case 'server.error':
    case 'toast':
    case 'branch.changed':
    // skills.changed — skill 目录热更新(zai skillWatcher)。不带 sid,
    // 每个 tab 都要重拉 /api/slash,否则只有触发变更的那个 tab 能看到
    // 新装 skill。
    case 'skills.changed':
    case 'session.created':
    case 'session.deleted':
    case 'session.renamed':
    case 'job.started':
    case 'job.progress':
    case 'job.done':
    case 'job.failed':
    case 'system.restarting':
    case 'system.stopping':
    case 'system.restart.canceled':
    case 'instance.changed':
    // app.update.* — zai 自身版本升级通道的事件,所有打开的 tab 都应收,
    // 否则只有最初连 SSE 的那个 tab 会看到「升级完成」弹窗,后开的
    // tab 永远不会被通知。
    case 'app.update.checking':
    case 'app.update.idle':
    case 'app.update.installing':
    case 'app.update.complete':
    case 'app.update.failed':
    // command.* — 命令生命周期埋点(/api/agent/command 路由发,所有 tab
    // 都该看见 — 调试 / 日志 / 慢命令分析不依赖具体 sid,跨 sid 广播)。命令
    // 起停对调试面板与活动指示器是关键信号。
    case 'command.run':
    case 'command.done':
    // task_factory — 任务工厂事件不绑定会话 sid(看板全局视图),跨 sid 广播。
    case 'task_factory':
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

// ─── 全局事件的 topic group 展开目标 ────────────────────────────────
// 与 isGlobalEvent() 保持同源:这里列的每个 type 在 isGlobalEvent 里也必须是
// true。语义是「与具体 session 解耦,任何订阅者都该收到」,因此可以在
// **没有 sid** 的订阅(非会话页面)里安全放行 —— 无 sid + topics 的组合是
// topicMatches 全局 group 唯一正确的使用姿势。
//
// 为什么要单独建集合而不是在 topicMatches 里散着写 if:
// 1. isGlobalEvent 是 switch,topicMatches 是 if 链,两份清单必须同步;
//    抽成集合后新增全局事件只要改一处(本块 + isGlobalEvent 的 case),
//    且 eventBus-topics.test.ts 有一条一致性断言守着(见该文件)。
// 2. 未来若有「全局事件但只允许特定 topic 消费」的需求,粒度也够细。

// instance.* — 实例生命周期(start/stop/heartbeat 超时)。实例管理页
// (/instances)自己不调 createNewSession,冷启动时 sessionId 为 null,
// 全靠这个 group 拿实时状态。
const GLOBAL_TOPIC_INSTANCE = new Set<string>(['instance.changed'])

// task_factory — 任务工厂看板事件,不带 sid(见 isGlobalEvent 注释)。
const GLOBAL_TOPIC_TASK_FACTORY = new Set<string>(['task_factory'])

// skills.changed — skill 目录热更新,不带 sid,所有 tab 都要重拉 /api/slash。
const GLOBAL_TOPIC_SKILLS = new Set<string>(['skills.changed'])

// command.* — 命令生命周期埋点,所有 tab 都该看见(调试 / 日志 / 耗时分析)。
const GLOBAL_TOPIC_COMMAND = new Set<string>(['command.run', 'command.done'])

// app.update.* — zai 自身版本升级通道,所有打开的 tab 都应收,否则只有
// 最先连上的那个 tab 能看到「升级完成」。
const GLOBAL_TOPIC_APP_UPDATE = new Set<string>([
  'app.update.checking',
  'app.update.idle',
  'app.update.installing',
  'app.update.complete',
  'app.update.failed',
])

// system.* + server.* — 连接态 / 错误 / toast / 分支变更 / 重启通知。
const GLOBAL_TOPIC_SYSTEM = new Set<string>([
  'server.connected',
  'server.error',
  'toast',
  'branch.changed',
  'system.restarting',
  'system.stopping',
  'system.restart.canceled',
])

// 流式事件 — 已经持久化在 transcript jsonl 的 [thinking + text + tool_use] blocks 里,
// 由 loadTranscriptMessages 在 transcript load 时还原。SSE history replay 推这些事件
// 会让客户端 upsertStreamBlock / upsertToolCall 写入额外 (thinking + text) 消息,
// 与 transcript 内容重复 (sess-1787931317204-8d39z9ou 4 气泡 bug 根因)。
// lastEventId===undefined (新 EventSource 实例 / reload) 时不 replay 它们;
// lastEventId 有值 (同 EventSource 重连续读) 时仍需 replay 让 delta 继续 append 到
// 既有 streaming message,不能丢 stream 内容。
const STREAMING_REPLAY_EXCLUDE = new Set<string>([
  'runtime.thinking',
  'runtime.delta',
  'runtime.tool_call',
  'runtime.tool_result',
])
function isStreamingReplayEvent(type: string): boolean {
  return STREAMING_REPLAY_EXCLUDE.has(type)
}

export class ServerEventBus {
  // 用 Array 而非 Set 是为了支持 emit 期间根据索引 splice 移除抛错的 subscriber:
  // 抛错的订阅者若留着,后续每次 emit 都会重复跑 + 累积 log, 形成死订阅堆积
  // (eventBus 自身只 log, 不清理)。索引式 for + splice(i,1)+i-- 是经典做法。
  private subs: Subscriber[] = []
  // 全局单调 seq 计数器 — emit 时分配, 单进程内单调递增, 进程重启后从 0
  // 重新计数 (跨重启的排序由 history replay + eventId 兜底, 见 shared/events.ts Base.seq 注释).
  private seqCounter = 0

  /**
   * 读出下一个即将分配的 seq(不消费)。让非 emit 路径(如 SSE 路由
   * 主动 push 合成 state 事件)能拿到一个高于当前 history 最大 seq 的
   * 起点,保证客户端 batch reorder 时合成 state 排在 history replay 之后。
   */
  getNextSeq(): number {
    return this.seqCounter + 1
  }
  private history: ServerEvent[] = []
  // per-sid 历史切片, 给 SSE 路由按 sid replay 用. 仅缓存有 sessionId 的事件;
  // 全局事件 (session.* / system.*) 留在全局 history, 它们不归某个 sid.
  // 容量同样按 CAPACITY 裁, 避免单 sid 长期占满内存.
  private historyBySid = new Map<string, ServerEvent[]>()

  /**
   * 发布一个事件。
   *
   * `opts.recordHistory === false` 表示「实时下发,但不进重放缓冲」——
   * 给周期性 / 无状态变化的事件用,见下方 instanceSupervisor 心跳的用法。
   * 默认 true,行为与此前完全一致。
   */
  emit(event: ServerEventInput, opts?: { recordHistory?: boolean }) {
    const full: ServerEvent = {
      ...event,
      eventId: event.eventId ?? nextId(),
      ts: event.ts ?? Date.now(),
      seq: event.seq ?? ++this.seqCounter,
    } as ServerEvent
    if (opts?.recordHistory !== false) {
      this.history.push(full)
      if (this.history.length > CAPACITY) {
        this.history.shift()
      }
      // 写 per-sid 切片 (仅当 event 带明确的 string sessionId)
      const sid = eventSessionId(full)
      if (typeof sid === 'string') {
        const arr = this.historyBySid.get(sid) ?? []
        arr.push(full)
        if (arr.length > CAPACITY) {
          arr.shift()
        }
        this.historyBySid.set(sid, arr)
      }
    }
    // 用索引式 for 而非 for-of 是为了支持在 catch 中按当前索引 splice 移除
    // 出错的 subscriber:抛错的订阅者会一直留在 subs 里,后续每次 emit 都白跑
    // 一遍,还会污染日志 / 累计异常。splice(i,1) 后必须 i--,否则下次循环 i++
    // 会跳过紧接其后的下一个订阅者(Set 迭代是安全的但 Array.splice 会左移)。
    for (let i = 0; i < this.subs.length; i++) {
      const sub = this.subs[i]
      try {
        sub(full)
      } catch (err) {
        console.error('[eventBus] subscriber threw, removing', err)
        this.subs.splice(i, 1)
        i--
      }
    }
  }

  getHistoryAfter(lastEventId?: string): ServerEvent[] {
    // lastEventId===undefined 时也回放该进程保留的最近 history(否则
    // 新 EventSource 实例 + sessionId 切换场景下,重连前 gap 内 emit 的
    // 事件永远没人收 — 详细见 getHistoryAfterForSid 同款注释)。
    // 上限 CAPACITY=256,客户端 applyBatch 按 eventId/seq 去重,
    // 多回放对 UI 无副作用。
    if (lastEventId === undefined) return [...this.history]
    const idx = this.history.findIndex((e) => e.eventId === lastEventId)
    if (idx < 0) return [...this.history]
    return this.history.slice(idx + 1)
  }

  // 仅返回属于该 sid 的事件历史 (Last-Event-ID 续读用). 不包含 session.* /
  // system.* 等全局事件 — 那些由 EventSource 在 client 端从 store 同步,
  // SSE 渠道不需要重发 (server.connected 单独在 connect 时即时推送).
  //
  // lastEventId===undefined 路径额外过滤 streaming events (runtime.thinking /
  // delta / tool_call / tool_result): 这些事件已经持久化在 transcript jsonl,
  // 由 loadTranscriptMessages 在 reload 时还原。replay 给客户端会让
  // upsertStreamBlock / upsertToolCall 写入额外 (thinking + text) 消息,与
  // transcript 内容重复 (sess-1787931317204-8d39z9ou 4 气泡 bug 根因)。
  // lastEventId 有值时不过滤 — EventSource 自动重连的续读场景,delta
  // 必须继续 append 到既有 streaming message,丢了会断流。
  getHistoryAfterForSid(lastEventId: string | undefined, sid: string): ServerEvent[] {
    const arr = this.historyBySid.get(sid) ?? []
    const slice = this._sliceAfter(arr, lastEventId)
    if (lastEventId === undefined) {
      // 新 EventSource 实例 / reload: 过滤 streaming events,避免与 transcript load 重复
      return slice.filter((e) => !isStreamingReplayEvent(e.type))
    }
    return slice
  }

  // EventSource 重连续读:从 lastEventId 之后开始切片,找不到 lastEventId 时
  // 退到全量 (与 lastEventId===undefined 一致 — 续读如果断点丢失,只能假设
  // 客户端靠 transcript load + 后续 live event 兜底)。
  private _sliceAfter(arr: ServerEvent[], lastEventId: string | undefined): ServerEvent[] {
    if (lastEventId === undefined) return [...arr]
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
   * - 'instance' / 'task_factory' / 'skills' / 'command' / 'app_update' →
   *   与 isGlobalEvent 同源的全局事件 group(见下方 GLOBAL_TOPIC_*)
   *
   * 未知 group/type 一律 false,白名单 semantics。
   *
   * 全局 group 的意义:「当前没有活跃会话」的页面(实例管理 / 管理 / 仪表盘)
   * 也需要收 instance.* / task_factory 这类**不依赖 sid** 的事件,否则
   * 那些页面永远收不到推送。这类订阅不能用「无 sid 全量流」代替 ——
   * runtime.* / prompt.* 的 reducer 并不按 sid 过滤(applyPromptAsk 直接
   * 覆盖 pendingAsk),全量流会把别的会话的待确认卡片串到当前页。必须走
   * topics 白名单,只放行真正全局的 type。
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
      if (t === 'instance' && GLOBAL_TOPIC_INSTANCE.has(type)) return true
      if (t === 'task_factory' && GLOBAL_TOPIC_TASK_FACTORY.has(type)) return true
      if (t === 'skills' && GLOBAL_TOPIC_SKILLS.has(type)) return true
      if (t === 'command' && GLOBAL_TOPIC_COMMAND.has(type)) return true
      if (t === 'app_update' && GLOBAL_TOPIC_APP_UPDATE.has(type)) return true
      if (t === 'system' && GLOBAL_TOPIC_SYSTEM.has(type)) return true
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
    this.subs.push(wrapped)
    return () => {
      const idx = this.subs.indexOf(wrapped)
      if (idx >= 0) this.subs.splice(idx, 1)
    }
  }

  subscribe(sub: Subscriber): () => void {
    this.subs.push(sub)
    return () => {
      const idx = this.subs.indexOf(sub)
      if (idx >= 0) this.subs.splice(idx, 1)
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
    this.subs.push(wrapped)
    return () => {
      const idx = this.subs.indexOf(wrapped)
      if (idx >= 0) this.subs.splice(idx, 1)
    }
  }
}

export const eventBus = new ServerEventBus()