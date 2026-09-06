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
    // zai patch (2026-09-06): idle path also goes to nextStep so the
    // bg event rides through the vendor preApiCallReminders hook as
    // a <system-reminder> block, instead of becoming a plain-text
    // user prompt on a new auto-started turn. Matches vendor's own
    // bg-daemon behavior (buildInboxSystemReminder at query.ts:701).
    // `runNextInQueue` will start an empty-prompt turn when nextStep
    // has content but sessionQueues + nextTurn are empty.
    this.lanesFor(sessionId).nextStep.push(msg)
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
