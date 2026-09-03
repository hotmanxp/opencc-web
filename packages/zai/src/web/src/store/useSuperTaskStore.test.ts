import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSuperTaskStore } from './useSuperTaskStore'
import type { TaskBucket } from '../lib/superTaskApi'

const EMPTY: TaskBucket = { queue: [], processing: [], verifying: [], finished: [] }

beforeEach(() => {
  useSuperTaskStore.setState({
    buckets: EMPTY, managed: false, loading: false, error: null,
    supervisorSessionId: null, lastHash: null, loadedOnce: false,
  })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useSuperTaskStore', () => {
  it('load 拉取三栏并写入 state', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ buckets: { queue: [{ id: 'tf-1', title: 'a', status: 'queued', bucket: 'queue-tasks' }], processing: [], finished: [] }, managed: true }) }),
    ))
    await useSuperTaskStore.getState().load()
    const s = useSuperTaskStore.getState()
    expect(s.buckets.queue[0]?.id).toBe('tf-1')
    expect(s.managed).toBe(true)
  })

  it.each([
    ['start', '/api/super-tasks/tf-a/start'],
    ['pause', '/api/super-tasks/tf-a/pause'],
    ['resume', '/api/super-tasks/tf-a/resume'],
    ['accept', '/api/super-tasks/tf-a/accept'],
  ])('%s 调 %s 并 load 刷新', async (action, expectedUrl) => {
    const calls: Array<{ url: string; method?: string }> = []
    vi.stubGlobal('fetch', vi.fn((url: string, init: { method?: string }) => {
      calls.push({ url, method: init?.method })
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
    }))
    await useSuperTaskStore.getState()[action as 'start']('tf-a')
    const hit = calls.find((c) => c.url === expectedUrl)
    expect(hit).toBeTruthy()
    expect(hit?.method ?? 'GET').toBe('POST')
    expect(calls.at(-1)?.url).toBe('/api/super-tasks') // load 兜底
  })
})

describe('useSuperTaskStore since-hash 短路(2026-09-03 快照缓存)', () => {
  const fullDto = () => ({
    modified: true,
    hash: 'H2',
    buckets: { queue: [{ id: 'tf-9', title: 'new', status: 'queued', bucket: 'queue-tasks' }], processing: [], verifying: [], finished: [] },
    managed: false,
    supervisorSessionId: 'sess-x',
  })

  it('modified:false → 不覆盖 buckets、不产生任何 set、不闪 loading', async () => {
    const original: TaskBucket = { queue: [{ id: 'tf-keep', title: 'keep', status: 'queued', bucket: 'queue-tasks' }], processing: [], verifying: [], finished: [] }
    useSuperTaskStore.setState({ buckets: original, loadedOnce: true, lastHash: 'H1', managed: true, supervisorSessionId: 'sess-keep' })
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ modified: false, hash: 'H1' }) }))
    vi.stubGlobal('fetch', fetchMock)
    let setCount = 0
    const unsub = useSuperTaskStore.subscribe(() => { setCount++ })
    try {
      await useSuperTaskStore.getState().load()
    } finally {
      unsub()
    }
    const s = useSuperTaskStore.getState()
    // 请求带 since(H1 含 | 需 URL 编码)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/super-tasks?since=${encodeURIComponent('H1')}`)
    // store 完全未动
    expect(s.buckets).toBe(original)
    expect(s.supervisorSessionId).toBe('sess-keep')
    expect(s.loading).toBe(false)
    expect(setCount).toBe(0)
  })

  it('modified:true → 全量更新并记录新 hash;下一轮带新 since', async () => {
    useSuperTaskStore.setState({ loadedOnce: true, lastHash: 'H1' })
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: async () => fullDto() }))
    vi.stubGlobal('fetch', fetchMock)
    await useSuperTaskStore.getState().load()
    const s = useSuperTaskStore.getState()
    expect(s.buckets.queue[0]?.id).toBe('tf-9')
    expect(s.supervisorSessionId).toBe('sess-x')
    expect(s.lastHash).toBe('H2')
    expect(s.loading).toBe(false)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/super-tasks?since=${encodeURIComponent('H1')}`)
    // 第二轮:since 用最新的 H2
    await useSuperTaskStore.getState().load()
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/super-tasks?since=${encodeURIComponent('H2')}`)
  })

  it('fetch 报错 → error 写入且 lastHash 清空,下一轮不带 since 强制全量', async () => {
    useSuperTaskStore.setState({ loadedOnce: true, lastHash: 'H1' })
    let n = 0
    const fetchMock = vi.fn(() => {
      n++
      if (n === 1) return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
      return Promise.resolve({ ok: true, json: async () => fullDto() })
    })
    vi.stubGlobal('fetch', fetchMock)
    await useSuperTaskStore.getState().load()
    const afterErr = useSuperTaskStore.getState()
    expect(afterErr.error).toBe('boom')
    expect(afterErr.lastHash).toBeNull()
    await useSuperTaskStore.getState().load()
    // 第 2 次调用不带 since(强制全量),成功回来后恢复 hash
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/super-tasks')
    expect(useSuperTaskStore.getState().lastHash).toBe('H2')
  })

  it('resetSupervisorSession 清空 lastHash,下一轮不带 since', async () => {
    useSuperTaskStore.setState({ loadedOnce: true, lastHash: 'H1', supervisorSessionId: 'sess-old' })
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: async () => fullDto() }))
    vi.stubGlobal('fetch', fetchMock)
    await useSuperTaskStore.getState().resetSupervisorSession()
    expect(useSuperTaskStore.getState().lastHash).toBeNull()
    await useSuperTaskStore.getState().load()
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/super-tasks')
  })

  it('首载(无 lastHash)不短路:请求不带 since 且 loading 置位到成功为止', async () => {
    let sawLoading = false
    const fetchMock = vi.fn(() => {
      sawLoading = useSuperTaskStore.getState().loading
      return Promise.resolve({ ok: true, json: async () => fullDto() })
    })
    vi.stubGlobal('fetch', fetchMock)
    await useSuperTaskStore.getState().load()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/super-tasks')
    expect(sawLoading).toBe(true) // 首轮 loading 占位语义保持
    expect(useSuperTaskStore.getState().loadedOnce).toBe(true)
  })
})