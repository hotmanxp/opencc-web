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

  // ========== disposeAll(M3 / `repl-registry-child-process-leak`) ==========
  //
  // `sh -c` + piped stdio 的子进程是普通同进程组进程,父进程干净 exit(0) 时
  // 收不到任何信号,会被 init 收养继续存活;managed child 以 detached:false
  // spawn 按 pid kill,supervisor 驱动的重启也扫不到这些孙进程。所以
  // closeServer 必须显式调 disposeAll —— 这条接线原先完全没有测试覆盖。

  it('disposeAll 清空全部 session', () => {
    const reg = getReplRegistry()
    reg.get('sess-A', '/tmp')
    reg.get('sess-B', '/tmp')
    reg.get('sess-C', '/tmp')
    expect(reg.size()).toBe(3)

    reg.disposeAll()

    expect(reg.size()).toBe(0)
  })

  it('disposeAll 之后再 get 创建全新实例(旧实例已释放)', () => {
    const reg = getReplRegistry()
    const before = reg.get('sess-A', '/tmp')
    reg.disposeAll()
    const after = reg.get('sess-A', '/tmp')
    expect(after).not.toBe(before)
    expect(reg.size()).toBe(1)
  })

  it('disposeAll 对空 registry 是 no-op', () => {
    const reg = getReplRegistry()
    expect(() => reg.disposeAll()).not.toThrow()
    expect(reg.size()).toBe(0)
  })

  it('单个 session dispose 抛错不阻断其余回收', () => {
    const reg = getReplRegistry()
    const a = reg.get('sess-A', '/tmp')
    reg.get('sess-B', '/tmp')
    // 让 A 的 dispose 抛错,模拟子进程已死 / kill 失败
    ;(a as unknown as { dispose: () => void }).dispose = () => { throw new Error('kill failed') }

    expect(() => reg.disposeAll()).not.toThrow()

    // 关键:B 也必须被摘掉 —— 不能因为 A 抛错就漏掉剩下的
    expect(reg.size()).toBe(0)
  })
})