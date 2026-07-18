// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { fetchV2Tasks } from './v2TaskApi.js'

// 包 vitest.config.ts 默认 environment: 'node', 没有 localStorage. 用
// 内存 stub 提供 setItem/clear/getItem, 让 brief 给定的测试代码可以原样
// 跑通. 不加 @vitest-environment happy-dom 是为了不和 taskApi.ts 同
// 目录的其它单测共享 node 环境, 也避免改动 vitest.config 触发连锁影响.
const memoryStorage = (() => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => { m.clear() },
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size },
  }
})()

describe('fetchV2Tasks', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // 装一个内存版的 localStorage 让 brief 给的测试代码可直接跑通.
    ;(globalThis as any).localStorage = memoryStorage
    localStorage.clear()
  })

  test('GET 路径正确 + 返回 task 数组', async () => {
    localStorage.setItem('zai-token', 'tok-123')
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tasks: [{ id: 't1', subject: 'demo', status: 'pending', blocks: [], blockedBy: [], updatedAt: 0 }] }),
    })
    // @ts-expect-error mock fetch
    globalThis.fetch = mockFetch

    const tasks = await fetchV2Tasks('sess-abc')
    expect(tasks[0]?.subject).toBe('demo')
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/agent/sessions/sess-abc/v2-tasks'),
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Zai-Token': 'tok-123' }) }),
    )
  })

  test('HTTP 非 2xx 抛错', async () => {
    // @ts-expect-error mock fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    await expect(fetchV2Tasks('s1')).rejects.toThrow(/500/)
  })
})