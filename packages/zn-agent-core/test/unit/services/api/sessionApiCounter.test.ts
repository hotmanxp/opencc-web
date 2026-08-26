import { describe, it, expect, beforeEach } from 'vitest'
import {
  setCurrentApiCountSession,
  recordApiCall,
  getApiCallCount,
  clearApiCallCount,
  setLastContextUsage,
  getLastContextTokens,
  __resetApiCallCountsForTests,
} from '../../../../src/opencc-src/services/api/sessionApiCounter.js'

// vendor sessionApiCounter 单元测试: per-session 计数 + 隔离 + 清空
// + 最近 context usage 缓存。
//
// 注:本模块用 globalThis 传 sid(同 zai 服 setCurrentApiCountSession
// 同步设),不依赖 sdkContextStorage — 因为模块要自包含,让 esbuild
// bundle:false 编出的 .js 在 zai dev (Node ESM) 下能直接 resolve。

beforeEach(() => {
  __resetApiCallCountsForTests()
})

describe('sessionApiCounter — recordApiCall / getApiCallCount', () => {
  it('setCurrentApiCountSession + recordApiCall 累加', () => {
    setCurrentApiCountSession('sess-a')
    recordApiCall()
    recordApiCall()
    recordApiCall()
    expect(getApiCallCount('sess-a')).toBe(3)
  })

  it('不同 session 互不干扰(per-session 独立计数)', () => {
    setCurrentApiCountSession('sess-a')
    recordApiCall()
    recordApiCall()
    setCurrentApiCountSession('sess-b')
    recordApiCall()
    setCurrentApiCountSession(null) // 模拟 vendor 不在 zai 调用栈时(无 session)
    expect(getApiCallCount('sess-a')).toBe(2)
    expect(getApiCallCount('sess-b')).toBe(1)
  })

  it('getApiCallCount 对未知 session 返回 0', () => {
    expect(getApiCallCount('sess-never-seen')).toBe(0)
  })

  it('clearApiCallCount 清空指定 session 计数', () => {
    setCurrentApiCountSession('sess-a')
    recordApiCall()
    recordApiCall()
    expect(getApiCallCount('sess-a')).toBe(2)
    clearApiCallCount('sess-a')
    expect(getApiCallCount('sess-a')).toBe(0)
  })

  it('recordApiCall 在没设 sessionId 时 no-op(对应 verifyApiKey 等早期调用)', () => {
    setCurrentApiCountSession(null)
    recordApiCall()
    recordApiCall()
    expect(getApiCallCount('sess-a')).toBe(0)
    expect(getApiCallCount('sess-b')).toBe(0)
  })

  it('__resetApiCallCountsForTests 清空全部 session', () => {
    setCurrentApiCountSession('sess-a')
    recordApiCall()
    setCurrentApiCountSession('sess-b')
    recordApiCall()
    expect(getApiCallCount('sess-a')).toBe(1)
    expect(getApiCallCount('sess-b')).toBe(1)
    __resetApiCallCountsForTests()
    expect(getApiCallCount('sess-a')).toBe(0)
    expect(getApiCallCount('sess-b')).toBe(0)
  })
})

describe('sessionApiCounter — last context usage 缓存', () => {
  it('setLastContextUsage + getLastContextTokens 返回 input + cache_creation + cache_read', () => {
    setLastContextUsage({ input: 100, cache_creation: 50, cache_read: 200, output: 30 })
    // 100 + 50 + 200 = 350(output 不算 context 大小)
    expect(getLastContextTokens()).toBe(350)
  })

  it('无 setLastContextUsage 时返回 null', () => {
    expect(getLastContextTokens()).toBeNull()
  })

  it('setLastContextUsage 多次:最新覆盖(累计 usage 替换前值)', () => {
    setLastContextUsage({ input: 100, cache_creation: 0, cache_read: 0, output: 10 })
    setLastContextUsage({ input: 200, cache_creation: 0, cache_read: 0, output: 20 })
    expect(getLastContextTokens()).toBe(200)
  })

  it('__resetApiCallCountsForTests 也清空 last usage', () => {
    setLastContextUsage({ input: 100, cache_creation: 0, cache_read: 0, output: 10 })
    expect(getLastContextTokens()).toBe(100)
    __resetApiCallCountsForTests()
    expect(getLastContextTokens()).toBeNull()
  })
})
