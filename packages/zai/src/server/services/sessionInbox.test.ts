import { describe, it, expect, beforeEach } from 'vitest'
import { SessionInbox, type InboxMessage } from './sessionInbox.js'

function msg(id: string): InboxMessage {
  return { id, source: { kind: 'test', form: 'notice' }, content: `content-${id}`, createdAt: 1 }
}

describe('SessionInbox', () => {
  let inbox: SessionInbox
  let woken: string[]
  beforeEach(() => {
    inbox = new SessionInbox()
    woken = []
    inbox.setWakeHandler((sid) => woken.push(sid))
  })

  it('followup: idle + 预算内 → 入 next-turn 并唤醒(用户消息注入语义)', () => {
    inbox.followup('s1', msg('a'))
    expect(woken).toEqual(['s1'])
    // zai patch (2026-09-06, revert 665a70c1): idle followup 走 nextTurn
    // (恢复"用户消息注入"语义)— runNextInQueue 把 msg.content 当真实
    // cmd.prompt 喂给 vendor query() 落盘 + 唤醒 LLM。busy 时的 followup
    // 仍走 nextStep(见下条 case),由 vendor hook 在用户下一条 prompt
    // 的 API call 时 prepend <system-reminder>。
    expect(inbox.consumeNextTurn('s1')?.id).toBe('a')
    expect(inbox.consumeNextStep('s1')).toEqual([])
  })

  it('followup: busy → 不唤醒,降级入 next-step', () => {
    inbox.setBusy('s1')
    inbox.followup('s1', msg('a'))
    expect(woken).toEqual([])
    expect(inbox.consumeNextTurn('s1')).toBeNull()
    expect(inbox.consumeNextStep('s1').map((m) => m.id)).toEqual(['a'])
  })

  it('inject: 永不唤醒,只入 next-step', () => {
    inbox.inject('s1', msg('a'))
    inbox.inject('s1', msg('b'))
    expect(woken).toEqual([])
    expect(inbox.consumeNextStep('s1').map((m) => m.id)).toEqual(['a', 'b'])
    expect(inbox.consumeNextStep('s1')).toEqual([])
  })

  it('steer: idle + 预算内 → 入 next-step 并唤醒', () => {
    inbox.steer('s1', msg('a'))
    expect(woken).toEqual(['s1'])
    expect(inbox.consumeNextStep('s1').map((m) => m.id)).toEqual(['a'])
  })

  it('wakeBudget: 默认 3 后 followup 不再唤醒(先 busy 消耗一轮)', () => {
    inbox.setBusy('s1')
    inbox.followup('s1', msg('a'))  // busy,不耗预算
    inbox.clearRunning('s1')
    inbox.followup('s1', msg('1'))
    inbox.followup('s1', msg('2'))
    inbox.followup('s1', msg('3'))
    expect(woken.length).toBe(3)
    inbox.followup('s1', msg('4'))   // 预算耗尽:入队不唤醒
    expect(woken.length).toBe(3)
    // 恢复 665a70c1 之前:idle followup 进 nextTurn。busy 那条('a')在
    // nextStep;idle 4 条('1','2','3','4')全部在 nextTurn。
    expect(inbox.peekNextTurnCount('s1')).toBe(4)
    expect(inbox.peekNextStepCount('s1')).toBe(1)
  })

  it('resetWakeBudget: 用户人工输入后预算恢复', () => {
    inbox.followup('s1', msg('1'))
    inbox.followup('s1', msg('2'))
    inbox.followup('s1', msg('3'))
    inbox.resetWakeBudget('s1')
    inbox.followup('s1', msg('4'))
    expect(woken.length).toBe(4)
  })

  it('clearRunning: 清 busy 并重置预算', () => {
    inbox.setBusy('s1')
    inbox.followup('s1', msg('a'))
    expect(inbox.isBusy('s1')).toBe(true)
    inbox.clearRunning('s1')
    expect(inbox.isBusy('s1')).toBe(false)
    inbox.followup('s1', msg('b'))
    expect(woken.length).toBe(1)
  })

  it('跨 session 隔离', () => {
    inbox.inject('s1', msg('a1'))
    inbox.inject('s2', msg('b1'))
    expect(inbox.consumeNextStep('s1').map((m) => m.id)).toEqual(['a1'])
    expect(inbox.consumeNextStep('s2').map((m) => m.id)).toEqual(['b1'])
  })
})