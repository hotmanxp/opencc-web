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

  it('followup: idle + 预算内 → 入 next-turn 并唤醒', () => {
    inbox.followup('s1', msg('a'))
    expect(woken).toEqual(['s1'])
    expect(inbox.consumeNextTurn('s1')?.id).toBe('a')
    expect(inbox.consumeNextTurn('s1')).toBeNull()
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
    expect(inbox.peekNextTurnCount('s1')).toBe(4)
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