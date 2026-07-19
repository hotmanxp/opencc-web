import { describe, expect, test } from 'vitest'
import { AskRegistry } from './askRegistry.js'

describe('AskRegistry', () => {
  test('register → answer resolves with payload', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', ctrl.signal)
    const ok = reg.answer('t1', { answers: { q1: 'yes' } })
    expect(ok).toBe(true)
    await expect(p).resolves.toEqual({ answers: { q1: 'yes' } })
  })

  test('register → reject rejects the pending promise', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', ctrl.signal)
    reg.reject('t1', 'user_rejected')
    await expect(p).rejects.toThrow('user_rejected')
  })

  test('abort on signal rejects the pending promise', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', ctrl.signal)
    ctrl.abort()
    await expect(p).rejects.toThrow('aborted')
  })

  test('abortAll rejects all pending and clears', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const p1 = reg.register('t1', 's1', ctrl.signal)
    const p2 = reg.register('t2', 's1', ctrl.signal)
    reg.abortAll('session_aborted')
    await expect(p1).rejects.toThrow('session_aborted')
    await expect(p2).rejects.toThrow('session_aborted')
  })

  test('answer 不存在的 toolUseId → 返回 false 不抛错', () => {
    const reg = new AskRegistry()
    expect(reg.answer('nonexistent', { answers: {} })).toBe(false)
  })

  test('重复 answer 同一 toolUseId → 第二次 false, 第一次仍 resolve', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', ctrl.signal)
    expect(reg.answer('t1', { answers: { q1: 'a' } })).toBe(true)
    expect(reg.answer('t1', { answers: { q1: 'b' } })).toBe(false)
    await expect(p).resolves.toEqual({ answers: { q1: 'a' } })
  })

  // ========== peek (给 handler 做 sid 串号校验用) ==========

  test('peek 返回 pending 的 sessionId, 不 consume', () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    reg.register('t1', 'sess-A', ctrl.signal)
    const peeked = reg.peek('t1')
    expect(peeked?.sessionId).toBe('sess-A')
    expect(peeked?.toolUseId).toBe('t1')
    // peek 不该清除 pending
    expect(reg.peek('t1')?.sessionId).toBe('sess-A')
  })

  test('peek 找不到 → undefined', () => {
    const reg = new AskRegistry()
    expect(reg.peek('nonexistent')).toBeUndefined()
  })

  test('peek 后 answer 仍能 resolve', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 'sess-A', ctrl.signal)
    reg.peek('t1') // peek 不应改变状态
    expect(reg.answer('t1', { answers: { q1: 'a' } })).toBe(true)
    await expect(p).resolves.toEqual({ answers: { q1: 'a' } })
  })
})
