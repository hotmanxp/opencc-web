import { describe, expect, test } from 'vitest'
import { ApproveRegistry } from './approveRegistry.js'

describe('ApproveRegistry', () => {
  test('register + answer resolves with payload', async () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', 'docs/spec.md', ctrl.signal)
    const ok = reg.answer('t1', { decision: 'approved', comment: 'looks good' })
    expect(ok).toBe(true)
    await expect(p).resolves.toEqual({ decision: 'approved', comment: 'looks good' })
  })

  test('register + reject rejects with default reason', async () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', 'docs/spec.md', ctrl.signal)
    reg.reject('t1')
    await expect(p).rejects.toThrow('user_rejected')
  })

  test('answer / reject on unknown toolUseId → false, no throw', () => {
    const reg = new ApproveRegistry()
    expect(reg.answer('nope', { decision: 'approved' })).toBe(false)
    expect(reg.reject('nope')).toBe(false)
  })

  test('abort signal rejects pending Promise and removes it', async () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', 'docs/spec.md', ctrl.signal)
    expect(reg.peek('t1')).toBeDefined()
    ctrl.abort()
    await expect(p).rejects.toThrow('aborted')
    expect(reg.peek('t1')).toBeUndefined()
  })

  test('abortAll rejects every pending entry', async () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    const p1 = reg.register('t1', 's1', 'a.md', ctrl.signal)
    const p2 = reg.register('t2', 's1', 'b.md', ctrl.signal)
    reg.abortAll('session_aborted')
    await expect(p1).rejects.toThrow('session_aborted')
    await expect(p2).rejects.toThrow('session_aborted')
  })

  test('listBySession filters correctly', () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    reg.register('t1', 'sess-A', 'a.md', ctrl.signal)
    reg.register('t2', 'sess-A', 'b.md', ctrl.signal)
    reg.register('t3', 'sess-B', 'c.md', ctrl.signal)
    expect(reg.listBySession('sess-A').map((p) => p.toolUseId).sort()).toEqual(['t1', 't2'])
    expect(reg.listBySession('sess-B').map((p) => p.toolUseId)).toEqual(['t3'])
    expect(reg.listBySession('sess-X')).toEqual([])
  })

  test('peek returns Pending with sessionId + filePath', () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    reg.register('t1', 's1', 'docs/spec.md', ctrl.signal)
    expect(reg.peek('t1')).toEqual(
      expect.objectContaining({ sessionId: 's1', filePath: 'docs/spec.md' }),
    )
  })

  test('X-Session-Id defense: peek allows read before answer', () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    reg.register('t1', 'sess-A', 'docs/spec.md', ctrl.signal)
    expect(reg.peek('t1')?.sessionId).toBe('sess-A')
    expect(reg.peek('unknown')).toBeUndefined()
  })

  test('approved without comment is allowed', async () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', 'docs/spec.md', ctrl.signal)
    reg.answer('t1', { decision: 'approved' })
    await expect(p).resolves.toEqual({ decision: 'approved' })
  })

  test('getFilePath returns the path supplied at register time', () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    reg.register('t1', 's1', 'docs/spec.md', ctrl.signal)
    expect(reg.getFilePath('t1')).toBe('docs/spec.md')
    expect(reg.getFilePath('unknown')).toBeUndefined()
  })

  test('getFilePath is cleared after answer / reject / abort', () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    reg.register('t1', 's1', 'docs/spec.md', ctrl.signal)
    reg.answer('t1', { decision: 'approved' })
    expect(reg.getFilePath('t1')).toBeUndefined()
  })
})
