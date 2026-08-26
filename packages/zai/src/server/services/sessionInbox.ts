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

  peekNextTurnCount(sessionId: string): number {
    return this.lanesFor(sessionId).nextTurn.length
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

export const sessionInbox = new SessionInbox()