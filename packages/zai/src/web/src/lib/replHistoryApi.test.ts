import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchTopCommands,
  fetchTopCommandsWithPrefix,
} from './replHistoryApi.js'

const fetchMock = vi.fn()

describe('replHistoryApi — fetchTopCommands', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('默认 limit=10,不发 n 参数', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entries: [{ command: 'ls', count: 3 }] }),
    })
    const out = await fetchTopCommands()
    expect(fetchMock).toHaveBeenCalledWith('/api/bash/history/top10')
    expect(out.entries).toEqual([{ command: 'ls', count: 3 }])
  })

  it('自定义 limit → 带 n 参数', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entries: [] }),
    })
    await fetchTopCommands(25)
    expect(fetchMock).toHaveBeenCalledWith('/api/bash/history/top10?n=25')
  })

  it('response 非 200 → 抛 Error 含 status', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'oops',
    })
    await expect(fetchTopCommands()).rejects.toThrow(/500 oops/)
  })

  it('text() 抛错也不阻塞错误信息', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: () => Promise.reject(new Error('stream broken')),
    })
    await expect(fetchTopCommands()).rejects.toThrow(/502/)
  })
})

describe('replHistoryApi — fetchTopCommandsWithPrefix', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefix + 默认 limit → 带 q 参数,不带 n', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entries: [{ command: 'git status', count: 2 }] }),
    })
    const out = await fetchTopCommandsWithPrefix('git')
    expect(fetchMock).toHaveBeenCalledWith('/api/bash/history/top10?q=git')
    expect(out.entries[0].command).toBe('git status')
  })

  it('空 prefix → 不发 q 参数', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entries: [] }),
    })
    await fetchTopCommandsWithPrefix('')
    expect(fetchMock).toHaveBeenCalledWith('/api/bash/history/top10')
  })

  it('prefix + limit → q 和 n 都在', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entries: [] }),
    })
    await fetchTopCommandsWithPrefix('npm', 5)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('q=npm')
    expect(url).toContain('n=5')
  })

  it('response 非 200 → 抛 Error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'not found',
    })
    await expect(fetchTopCommandsWithPrefix('x')).rejects.toThrow(/404 not found/)
  })
})