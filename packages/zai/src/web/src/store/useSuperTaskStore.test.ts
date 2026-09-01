import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSuperTaskStore } from './useSuperTaskStore'

describe('useSuperTaskStore', () => {
  beforeEach(() => {
    useSuperTaskStore.setState({ buckets: { queue: [], processing: [], finished: [] }, managed: false, loading: false })
    vi.restoreAllMocks()
  })

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