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

  it('followup: idle + 预算内 → 入 next-step 并唤醒(2026-09-06 统一入 nextStep 走 vendor hook)', () => {
    inbox.followup('s1', msg('a'))
    expect(woken).toEqual(['s1'])
    // Idle followup 改为入 nextStep(不再 nextTurn)— 让 vendor hook 在
    // 下次 API call 处理成 <system-reminder> 块,而不是 plain text prompt。
    expect(inbox.consumeNextTurn('s1')).toBeNull()
    expect(inbox.consumeNextStep('s1').map((m) => m.id)).toEqual(['a'])
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
    inbox.followup('s1', msg('a'))  // busy:入 nextStep 不唤醒
    inbox.clearRunning('s1')          // clearRunning 删 wakeBudget
    inbox.followup('s1', msg('1'))    // idle:入 nextStep + wake → wakeBudget=1
    inbox.followup('s1', msg('2'))    // wake → wakeBudget=2
    inbox.followup('s1', msg('3'))    // wake → wakeBudget=3
    expect(woken.length).toBe(3)
    inbox.followup('s1', msg('4'))    // 预算耗尽:入 nextStep 不唤醒
    expect(woken.length).toBe(3)
    // 2026-09-06 统一: idle followup 进 nextStep(不再 nextTurn)。总计
    // busy 那条 + idle 4 条 = 5 条。
    expect(inbox.peekNextStepCount('s1')).toBe(5)
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