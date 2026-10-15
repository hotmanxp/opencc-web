import { describe, expect, test } from 'vitest'
import { PermissionRegistry } from './permissionRegistry.js'

// permissionRegistry.ts 原先没有任何测试(与 ask/approve 不对称)。2026-10-05
// 改了 abortAll 的签名(加 sessionId 过滤),这里把语义钉住 —— 尤其是
// 「abortAll 是进程级单例,不带 sessionId 会波及别的会话」这条,S3 的根因。
describe('PermissionRegistry', () => {
  test('register + answer resolves with decision', async () => {
    const reg = new PermissionRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', ctrl.signal)
    expect(reg.answer('t1', { decision: 'allow' })).toBe(true)
    await expect(p).resolves.toEqual({ decision: 'allow' })
  })

  test('register + reject rejects with default reason', async () => {
    const reg = new PermissionRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', ctrl.signal)
    reg.reject('t1')
    await expect(p).rejects.toThrow('user_rejected')
  })

  test('abort on signal rejects the pending promise', async () => {
    const reg = new PermissionRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', ctrl.signal)
    ctrl.abort()
    await expect(p).rejects.toThrow('aborted')
  })

  test('peek 不 consume,返回 sessionId', () => {
    const reg = new PermissionRegistry()
    const ctrl = new AbortController()
    reg.register('t1', 'sess-A', ctrl.signal)
    expect(reg.peek('t1')?.sessionId).toBe('sess-A')
    expect(reg.peek('t1')).toBeDefined()
  })

  test('abortAll 传 sessionId → 只 abort 该会话的权限确认', async () => {
    const reg = new PermissionRegistry()
    const ctrl = new AbortController()
    const mine = reg.register('t1', 'sess-A', ctrl.signal)
    const theirs = reg.register('t2', 'sess-B', ctrl.signal)

    reg.abortAll('client_disconnect', 'sess-A')
    await expect(mine).rejects.toThrow('client_disconnect')

    // 别的会话的 permission 仍然挂着想答就能答 —— 修复前已被连带 abort。
    expect(reg.peek('t2')?.sessionId).toBe('sess-B')
    expect(reg.answer('t2', { decision: 'deny' })).toBe(true)
    await expect(theirs).resolves.toEqual({ decision: 'deny' })
  })

  test('abortAll 不传 sessionId → 仍是全量 abort(重启 drain 需要)', async () => {
    const reg = new PermissionRegistry()
    const ctrl = new AbortController()
    const p1 = reg.register('t1', 'sess-A', ctrl.signal)
    const p2 = reg.register('t2', 'sess-B', ctrl.signal)
    reg.abortAll('restart_drain_timeout')
    await expect(p1).rejects.toThrow('restart_drain_timeout')
    await expect(p2).rejects.toThrow('restart_drain_timeout')
  })
})
