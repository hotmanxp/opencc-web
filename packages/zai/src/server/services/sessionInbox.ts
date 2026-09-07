/**
 * SessionInbox — per-session 后台消息投递队列(移植自 DSH agent-loop 的 inbox)。
 *
 * 语义(对齐 DSH packages/core/agent-loop/src/agent.ts:113-132):
 *   followup = next-turn lane + wake(idle 且预算内)
 *   steer    = next-step lane + wake
 *   inject   = next-step lane,不唤醒
 * busy 时 followup 自动降级入 next-step(不打扰主线),turn 结束后由
 * consumeNextStep 合并为下一条 prompt —— 对齐 DSH「busy owner 被 inject,
 * settle 一起 cost 一步」的 intent。wakeBudget(默认 3)防止后台连环唤醒;
 * 用户人工输入(turn 结束)经 resetWakeBudget / clearRunning 恢复预算。
 *
 * zai patch (2026-09-06): 每个 session 独立 SessionInbox 实例,跨 session
 * 状态完全隔离。模块层保留 Map<sessionId, SessionInbox> 工厂,新 inbox
 * 创建时自动挂上 `setSessionInboxWakeHandler` 注册的 wake handler(避免
 * 工厂与 agent.ts 的循环依赖)。`sessionInbox` 单例导出仅作兼容保留 —
 * 生产代码不再使用,统一走 `getSessionInbox(sid)`。
 *
 * dsh 视角特有对齐(2026-09-07, plan §1 + plan §3, worktree-dsh):
 *   本模块对齐 dsh 微内核 session lifecycle 设计 — nextTurn / nextStep
 *   双车道对应 dsh Inbox 双队列(followup / steer lanes),followup /
 *   inject 事件通道对应 dsh agent loop wakeDriver 状态机(idle / busy /
 *   settling transitions)。wakeBudget 是 dsh `wakeCap` 配置字段的直接
 *   镜像 — dsh 默认 3 wake/turn,防止后台事件连环唤醒 owner agent。
 *
 *   与 zai 维度 1+2 隔离的接口: SessionInbox 是 per-session lane,
 *   vendor `commandQueue` 是进程级单例(sessionId 路由通过
 *   `QueuedCommand.sessionId` 字段, messageQueueAdapter.ts 注入)。
 *   两个存储互补: SessionInbox 处理 zai 自管的 inbox 通知(nextTurn
 *   prompt), vendor commandQueue 处理 vendor 内部 task-notification
 *   drain。两层都按 sessionId 隔离。
 */
export type InboxDelivery = 'wakeup' | 'quiet'

export interface InboxMessage {
  id: string
  source: {
    kind: string
    form: string
    senderSessionId?: string
    agentType?: string
    [k: string]: unknown
  }
  content: string
  createdAt: number
}

interface InboxLanes {
  nextTurn: InboxMessage[]
  nextStep: InboxMessage[]
}

export interface InboxWakeHandler {
  (sessionId: string): void
}

export const DEFAULT_WAKE_BUDGET = 3

export class SessionInbox {
  private readonly lanes = new Map<string, InboxLanes>()
  private readonly busy = new Set<string>()
  private readonly wakeBudget = new Map<string, number>()
  private wakeHandler: InboxWakeHandler = () => {}

  setWakeHandler(handler: InboxWakeHandler): void {
    this.wakeHandler = handler
  }

  followup(sessionId: string, msg: InboxMessage): void {
    if (this.busy.has(sessionId)) {
      this.lanesFor(sessionId).nextStep.push(msg)
      return
    }
    // zai patch (2026-09-06, revert 665a70c1): idle followup 走 nextTurn
    // (恢复成"用户消息注入"语义)— wake 触发 runNextInQueue 把 msg.content
    // 当作真实 cmd.prompt 喂给 vendor query(),落盘 transcript + 唤醒 LLM。
    // 之前改成 nextStep 让 vendor hook 在 API call 时 prepend <system-reminder>
    // 的设计,在 idle + 无后续 user prompt 场景下:空 prompt turn 推进 turnIndex
    // 但 LLM 不思考 → 后台通知"没地方唤醒 LLM"。busy 时的 followup 仍走 nextStep
    // (steer/inject 永远 nextStep),由 vendor hook 在用户下一条 prompt 的 API
    // call 时 prepend,这条路径保留 4ae1223b 的 vendor hook 设计。
    this.lanesFor(sessionId).nextTurn.push(msg)
    this.wakeIfBudgeted(sessionId)
  }

  steer(sessionId: string, msg: InboxMessage): void {
    this.lanesFor(sessionId).nextStep.push(msg)
    if (this.busy.has(sessionId)) return
    this.wakeIfBudgeted(sessionId)
  }

  inject(sessionId: string, msg: InboxMessage): void {
    this.lanesFor(sessionId).nextStep.push(msg)
  }

  consumeNextTurn(sessionId: string): InboxMessage | null {
    const m = this.lanesFor(sessionId).nextTurn.shift() ?? null
    this.gc(sessionId)
    return m
  }

  consumeNextStep(sessionId: string): InboxMessage[] {
    const lanes = this.lanesFor(sessionId)
    const out = lanes.nextStep
    lanes.nextStep = []
    this.gc(sessionId)
    return out
  }

  // zai patch (2026-09-07, fix-busy-flush-v2, worktree-dsh): 主 turn finally
  // 兜底 —— 把 busy 路径降级到 nextStep 的 inbox 消息在 turn 真正结束时提升
  // 到 nextTurn, 触发 runNextInQueue 唤醒 LLM 看到 <task-notification>。
  //
  // 背景: vendor QueryEngine 的 mid-turn drain(query.ts:2675 getCommandsByMaxPriority)
  // 只在 LLM **下一次 API call 之前** 触发, 与 print.ts 的 drainCommandQueue
  // (print.ts:2619) 不同 —— print.ts 是 EventDrivenPrint, 有订阅唤醒 run()
  // 的机制 (subscribeToHeadlessWake, print.ts:2095); repl 路径默认走
  // QueryEngine, **没有这个 wake 机制**。
  //
  // 现场 (sess-1788753456906-3fvboh58, 2026-09-07): 父 turn 派 Agent 子任务,
  // 子任务在父 turn **end_turn 之前** 完成。SubagentNotifier.handle → inbox.followup
  // 探测 busy 入 nextStep (per followup() 设计); vendor `enqueuePendingNotification`
  // 也推了一份到 vendor `commandQueue`。父 turn end_turn → 没有下一次 API call →
  // mid-turn drain 不跑 → nextStep 与 commandQueue 两份通知**双双卡住**, LLM 永远
  // 看不到 task-notification。
  //
  // 修法: 主 turn finally 里把 nextStep 全部提升到 nextTurn + 调 wakeHandler
  // (runNextInQueue) 触发新一轮 turn。wakeIfBudgeted 的 wake budget 限制保留
  // (默认 3 wake/turn, 避免后台连环唤醒); 超过预算的仍入 nextTurn 等下次
  // 用户输入, 不丢消息。
  promoteNextStepToNextTurn(sessionId: string): number {
    const lanes = this.lanesFor(sessionId)
    const count = lanes.nextStep.length
    if (count === 0) return 0
    // 全量提升 — 不区分来源 (subagent / bash / system_reminder), turn 结束
    // 全部当作"下一条 prompt 候选"对待, 等同 wake 后 runNextInQueue 按 nextTurn
    // FIFO 消费。
    while (lanes.nextStep.length > 0) {
      const m = lanes.nextStep.shift()
      if (m) lanes.nextTurn.push(m)
    }
    this.gc(sessionId)
    return count
  }

  peekNextTurnCount(sessionId: string): number {
    return this.lanesFor(sessionId).nextTurn.length
  }

  /**
   * Number of messages currently in the nextStep lane, WITHOUT
   * consuming them. Used by `runNextInQueue` to detect "idle session
   * but bg events pending" — when both sessionQueues and nextTurn are
   * empty but nextStep has content, we still need to start a turn so
   * the vendor hook (`query.ts:701`) can prepend the reminder.
   */
  peekNextStepCount(sessionId: string): number {
    return this.lanesFor(sessionId).nextStep.length
  }

  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId)
  }

  setBusy(sessionId: string): void {
    this.busy.add(sessionId)
  }

  clearRunning(sessionId: string): void {
    this.busy.delete(sessionId)
    this.wakeBudget.delete(sessionId)
  }

  resetWakeBudget(sessionId: string): void {
    this.wakeBudget.delete(sessionId)
  }

  // zai patch (2026-09-07, fix-busy-flush-v2, worktree-dsh): 显式 wake 入口,
  // 给 finally 兜底用。 busy 路径 followup 入 nextStep + 不 wake;
  // finally 释放 busy 之后调 promoteNextStepToNextTurn(sid) 把消息搬到
  // nextTurn, 然后 wakeFor(sid) 触发 wake handler (runNextInQueue),
  // 不走 followup / steer 那种 lane 选择, 直接拿 wake budget 试一次。
  //
  // wakeBudget 内超额时静默 no-op, 调用方应理解为"消息已入 nextTurn,
  // 等用户下条 prompt 一起消费" —— 不算丢。
  wakeFor(sessionId: string): void {
    this.wakeIfBudgeted(sessionId)
  }

  private wakeIfBudgeted(sessionId: string): void {
    const spent = this.wakeBudget.get(sessionId) ?? 0
    if (spent >= DEFAULT_WAKE_BUDGET) return
    this.wakeBudget.set(sessionId, spent + 1)
    try {
      this.wakeHandler(sessionId)
    } catch (err) {
      console.warn('[SessionInbox] wake handler threw:', err)
    }
  }

  private lanesFor(sessionId: string): InboxLanes {
    let lanes = this.lanes.get(sessionId)
    if (!lanes) {
      lanes = { nextTurn: [], nextStep: [] }
      this.lanes.set(sessionId, lanes)
    }
    return lanes
  }

  private gc(sessionId: string): void {
    const lanes = this.lanes.get(sessionId)
    if (lanes && lanes.nextTurn.length === 0 && lanes.nextStep.length === 0) {
      this.lanes.delete(sessionId)
    }
  }
}

// ---------------------------------------------------------------------------
// Per-session factory + lifecycle
// ---------------------------------------------------------------------------

const sessionInboxes = new Map<string, SessionInbox>()

/**
 * Module-level wake handler reference. `setSessionInboxWakeHandler` is
 * called once at startup (typically from `agent.ts`) so newly created
 * inbox instances auto-bind to it. This avoids a circular import
 * between `sessionInbox.ts` and `agent.ts` — agent.ts owns the wake
 * implementation (`runNextInQueue`), sessionInbox.ts owns the data.
 */
type SessionWakeFn = (sessionId: string) => Promise<void>
let moduleWakeHandler: SessionWakeFn | null = null

export function setSessionInboxWakeHandler(fn: SessionWakeFn): void {
  moduleWakeHandler = fn
}

/**
 * Return the per-session SessionInbox, lazily creating one if absent.
 * Newly created instances auto-attach the wake handler registered via
 * `setSessionInboxWakeHandler`.
 */
export function getSessionInbox(sessionId: string): SessionInbox {
  let inbox = sessionInboxes.get(sessionId)
  if (!inbox) {
    inbox = new SessionInbox()
    if (moduleWakeHandler) {
      const fn = moduleWakeHandler
      inbox.setWakeHandler((sid) => {
        fn(sid).catch((err) =>
          console.warn('[SessionInbox] wake runNextInQueue failed:', err),
        )
      })
    }
    sessionInboxes.set(sessionId, inbox)
  }
  return inbox
}

/**
 * Drop a session's inbox from the registry. Idempotent — calling with
 * an unknown sid is a no-op. Does NOT call any wake handler; the caller
 * is responsible for terminating any in-flight turn first.
 */
export function disposeSessionInbox(sessionId: string): void {
  sessionInboxes.delete(sessionId)
}

/**
 * List of session ids currently registered. Useful for shutdown /
 * `killAll` paths to dispose every inbox.
 */
export function listSessionInboxIds(): string[] {
  return [...sessionInboxes.keys()]
}

// ---------------------------------------------------------------------------
// Singleton — DEPRECATED. Kept exported so legacy callers (and the
// vendor compat bridge that asserts `globalThis.__zaiSessionInbox`
// exists) don't break. New code MUST use `getSessionInbox(sid)`.
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `getSessionInbox(sessionId)` instead. The singleton is
 * only kept for the vendor `inboxBridge.ts` globalThis assertion and a
 * handful of legacy imports; production call sites have all migrated.
 */
export const sessionInbox = new SessionInbox()
