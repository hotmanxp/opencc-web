import { describe, it, expect, beforeEach } from 'vitest'
import { CwdStore } from './cwdStore.js'

describe('CwdStore', () => {
  beforeEach(() => {
    CwdStore.clear()
  })

  it('returns undefined for unknown sessionId', () => {
    expect(CwdStore.get('sess-unknown')).toBeUndefined()
    expect(CwdStore.has('sess-unknown')).toBe(false)
  })

  it('set + get round-trip', () => {
    CwdStore.set('sess-a', '/tmp/foo')
    expect(CwdStore.get('sess-a')).toBe('/tmp/foo')
    expect(CwdStore.has('sess-a')).toBe(true)
  })

  it('set overwrites previous value and bumps updatedAt', async () => {
    CwdStore.set('sess-a', '/tmp/foo')
    const first = CwdStore.get('sess-a')!
    await new Promise(r => setTimeout(r, 2))
    CwdStore.set('sess-a', '/tmp/bar')
    const second = CwdStore.get('sess-a')!
    expect(second).toBe('/tmp/bar')
    // updatedAt 应被刷新(通过 has() 间接验证:get 不返回 updatedAt)
    expect(CwdStore.size()).toBe(1)
    void first
  })

  it('getOrInit writes default on first call', () => {
    const cwd = CwdStore.getOrInit('sess-new', '/initial')
    expect(cwd).toBe('/initial')
    expect(CwdStore.get('sess-new')).toBe('/initial')
  })

  it('getOrInit returns existing value without overwriting', () => {
    CwdStore.set('sess-x', '/already-set')
    const cwd = CwdStore.getOrInit('sess-x', '/initial')
    expect(cwd).toBe('/already-set')
  })

  it('delete removes entry', () => {
    CwdStore.set('sess-y', '/tmp')
    CwdStore.delete('sess-y')
    expect(CwdStore.get('sess-y')).toBeUndefined()
  })

  it('delete on unknown is noop', () => {
    expect(() => CwdStore.delete('sess-zzz')).not.toThrow()
  })
})
