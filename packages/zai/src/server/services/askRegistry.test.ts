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

  // ========== abortAll 的 sessionId 过滤(2026-10-05) ==========
  // bug `prompt-close-aborts-all-sessions`:registry 是进程级单例,abortAll
  // 原先无条件遍历全表 → 一个会话正常发 prompt 结束时的 close 事件会把
  // **别的会话**正挂着的 ask 一起 reject 掉。

  test('abortAll 传 sessionId → 只 abort 该会话,其它会话的 pending 不受影响', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const mine = reg.register('t1', 'sess-A', ctrl.signal)
    const theirs = reg.register('t2', 'sess-B', ctrl.signal)

    reg.abortAll('client_disconnect', 'sess-A')
    await expect(mine).rejects.toThrow('client_disconnect')

    // 关键断言:别的会话仍然挂着,还能正常作答。
    expect(reg.peek('t2')?.sessionId).toBe('sess-B')
    expect(reg.answer('t2', { answers: { q1: 'ok' } })).toBe(true)
    await expect(theirs).resolves.toEqual({ answers: { q1: 'ok' } })
  })

  test('abortAll 传一个不存在的 sessionId → 不 abort 任何东西', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 'sess-A', ctrl.signal)
    reg.abortAll('client_disconnect', 'sess-ZZZ')
    // 没有 pending 被清掉
    expect(reg.peek('t1')).toBeDefined()
    expect(reg.answer('t1', { answers: { q1: 'still alive' } })).toBe(true)
    await expect(p).resolves.toEqual({ answers: { q1: 'still alive' } })
  })

  test('abortAll 不传 sessionId → 仍是全量 abort(重启 drain 需要)', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const p1 = reg.register('t1', 'sess-A', ctrl.signal)
    const p2 = reg.register('t2', 'sess-B', ctrl.signal)
    reg.abortAll('restart_drain_timeout')
    await expect(p1).rejects.toThrow('restart_drain_timeout')
    await expect(p2).rejects.toThrow('restart_drain_timeout')
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

  test('重复 register 同 toolUseId 不堆 abort listener,只留一份 entry', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const warnings: string[] = []
    const onWarn = (w: Error) => warnings.push(w.name)
    process.on('warning', onWarn)
    try {
      // 60 次同 toolUseId — 修复前会让 AbortSignal 累计 60 个 listener,
      // 触发 MaxListenersExceededWarning;修复后每次覆盖都先 removeEventListener,
      // 最终 signal 上只有 1 个 listener,无告警。
      let last!: ReturnType<AskRegistry['register']>
      for (let i = 0; i < 60; i++) {
        last = reg.register('t1', 's1', ctrl.signal)
      }
      await new Promise((r) => setImmediate(r))
      expect(warnings).not.toContain('MaxListenersExceededWarning')
      // pending Map 只留最后一个 entry
      expect(reg.peek('t1')).toBeDefined()
      expect(reg.answer('t1', { answers: { q1: 'a' } })).toBe(true)
      await expect(last).resolves.toEqual({ answers: { q1: 'a' } })
    } finally {
      process.off('warning', onWarn)
    }
  })
})
