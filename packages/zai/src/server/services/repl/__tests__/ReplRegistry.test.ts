import { describe, expect, it, beforeEach } from 'vitest'
import { getReplRegistry, __resetReplRegistryForTest } from '../ReplRegistry.js'

describe('ReplRegistry', () => {
  beforeEach(() => __resetReplRegistryForTest())

  it('get 懒加载：首次调用创建实例', () => {
    const reg = getReplRegistry()
    const a = reg.get('sess-A', '/tmp')
    expect(a).toBeDefined()
    expect(a.cwd).toBe('/tmp')
  })

  it('同 sessionId 二次 get 返回相同实例', () => {
    const reg = getReplRegistry()
    const a1 = reg.get('sess-A', '/tmp')
    const a2 = reg.get('sess-A', '/tmp')
    expect(a1).toBe(a2)
  })

  it('不同 sessionId 互不干扰', () => {
    const reg = getReplRegistry()
    const a = reg.get('sess-A', '/tmp/A')
    const b = reg.get('sess-B', '/tmp/B')
    expect(a).not.toBe(b)
    expect(a.cwd).toBe('/tmp/A')
    expect(b.cwd).toBe('/tmp/B')
  })

  it('dispose 后再 get 创建新实例', () => {
    const reg = getReplRegistry()
    const a1 = reg.get('sess-A', '/tmp')
    reg.dispose('sess-A')
    const a2 = reg.get('sess-A', '/tmp')
    expect(a1).not.toBe(a2)
  })

  it('singleton: getReplRegistry 返回同一 registry', () => {
    const a = getReplRegistry()
    const b = getReplRegistry()
    expect(a).toBe(b)
  })
})