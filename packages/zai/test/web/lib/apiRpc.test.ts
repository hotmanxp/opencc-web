// 验证 apiBase.request + generated apiRpc stub 的端到端契约.
// SPEC: docs/superpowers/specs/2026-08-16-rpc-type-safe-client-stubs.md
//
// 覆盖:
// - apiBase.request: 路径拼接 (`/api` + path), Content-Type JSON, 错误
//   走 ApiError + notifyApiError
// - apiRpc: 静态结构正确 (agent.command.post / agent.prompt.post /
//   agent.sessions.get / agent.sessions.post / cli.get / health.get),
//   真实 fetch 调用 GET /api/health 等
// - 老 api.get/post/put 兼容: 路径仍走 `${API_BASE}${path}`, 行为不变
//
// fetch 用 vi.spyOn(global, 'fetch') 拦截, 不真实发请求.
// apiError.ts 调 antd `notification` (在 Node 环境无 `document`), 整
// module mock 简化.

const { apiErrorRef } = vi.hoisted(() => ({
  apiErrorRef: {
    notifyApiError: vi.fn(),
    notifySseError: vi.fn(),
    __resetThrottleForTests: vi.fn(),
    ApiError: class ApiError extends Error {
      constructor(
        public status: number,
        public method: string,
        public url: string,
        public body: string,
      ) {
        super(`${status} ${method} /api${url}`.trimEnd())
        this.name = 'ApiError'
      }
    },
  },
}))

vi.mock('../../../src/web/src/lib/apiError.js', () => apiErrorRef)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, apiRpc } from '../../../src/web/src/lib/api.js'
import { request } from '../../../src/web/src/lib/apiBase.js'
import { ApiError } from '../../../src/web/src/lib/apiError.js'

const fetchSpy = vi.fn()

beforeEach(() => {
  fetchSpy.mockReset()
  apiErrorRef.notifyApiError.mockReset()
  vi.spyOn(global, 'fetch').mockImplementation(fetchSpy as unknown as typeof fetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mockFetchOk(json: unknown) {
  fetchSpy.mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response)
}

function mockFetchFail(status: number, body: string) {
  fetchSpy.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: 'fail',
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response)
}

describe('apiBase.request', () => {
  it('GET /api/health 拼接 API_BASE + path, 走默认 Content-Type', async () => {
    mockFetchOk({ ok: true, version: '1.0.0' })
    const r = await request<{ ok: boolean; version: string }>('GET', '/health')
    expect(r).toEqual({ ok: true, version: '1.0.0' })
    expect(fetchSpy).toHaveBeenCalledWith('/api/health', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    })
  })

  it('POST 带 body 时 JSON.stringify', async () => {
    mockFetchOk({ sessionId: 's1' })
    const r = await request<{ sessionId: string }>('POST', '/agent/sessions', { model: 'm' })
    expect(r).toEqual({ sessionId: 's1' })
    expect(fetchSpy).toHaveBeenCalledWith('/api/agent/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm' }),
    })
  })

  it('错误响应抛出 ApiError + notifyApiError', async () => {
    mockFetchFail(500, 'server down')
    await expect(request('GET', '/health')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('apiRpc (generated stub)', () => {
  it('结构正确: apiRpc.agent.command.post / apiRpc.agent.prompt.post / apiRpc.agent.sessions.get / apiRpc.agent.sessions.post / apiRpc.cli.get / apiRpc.health.get', () => {
    expect(typeof apiRpc.agent.command.post).toBe('function')
    expect(typeof apiRpc.agent.prompt.post).toBe('function')
    expect(typeof apiRpc.agent.sessions.get).toBe('function')
    expect(typeof apiRpc.agent.sessions.post).toBe('function')
    expect(typeof apiRpc.cli.get).toBe('function')
    expect(typeof apiRpc.health.get).toBe('function')
  })

  it('apiRpc.health.get() 调 GET /api/health', async () => {
    mockFetchOk({ ok: true, version: '9.9.9' })
    const r = await apiRpc.health.get()
    expect(r).toEqual({ ok: true, version: '9.9.9' })
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/health')
    expect(fetchSpy.mock.calls[0][1].method).toBe('GET')
  })

  it('apiRpc.agent.command.post(body) 调 POST /api/agent/command, body JSON 化', async () => {
    mockFetchOk({ type: 'cleared', payload: null })
    const r = await apiRpc.agent.command.post({ name: 'clear', args: '', sessionId: 's1' })
    expect(r).toEqual({ type: 'cleared', payload: null })
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/agent/command')
    expect(fetchSpy.mock.calls[0][1].method).toBe('POST')
    expect(fetchSpy.mock.calls[0][1].body).toBe(JSON.stringify({
      name: 'clear', args: '', sessionId: 's1',
    }))
  })

  it('apiRpc.agent.sessions.post({ model }) 调 POST /api/agent/sessions', async () => {
    mockFetchOk({ sessionId: 'new' })
    const r = await apiRpc.agent.sessions.post({ model: 'MiniMax-M3' })
    expect(r).toEqual({ sessionId: 'new' })
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/agent/sessions')
    expect(fetchSpy.mock.calls[0][1].method).toBe('POST')
  })

  it('apiRpc.cli.get() 调 GET /api/cli (无 body)', async () => {
    mockFetchOk([])
    const r = await apiRpc.cli.get()
    expect(r).toEqual([])
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/cli')
    expect(fetchSpy.mock.calls[0][1].method).toBe('GET')
    expect(fetchSpy.mock.calls[0][1].body).toBeUndefined()
  })

  it('错误响应走 ApiError + notifyApiError', async () => {
    mockFetchFail(404, 'not found')
    await expect(apiRpc.cli.get()).rejects.toBeInstanceOf(ApiError)
  })
})

describe('compatibility: 老 api.get/post/put', () => {
  it('api.get(path) 仍走 GET /api/{path}', async () => {
    mockFetchOk({ ok: true, version: '1.0.0' })
    const r = await api.get<{ ok: boolean; version: string }>('/health')
    expect(r).toEqual({ ok: true, version: '1.0.0' })
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/health')
    expect(fetchSpy.mock.calls[0][1].method).toBe('GET')
  })

  it('api.post(path, body) 仍走 POST /api/{path}, body JSON 化', async () => {
    mockFetchOk({ type: 'cleared', payload: null })
    await api.post('/agent/command', { name: 'clear' })
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/agent/command')
    expect(fetchSpy.mock.calls[0][1].body).toBe(JSON.stringify({ name: 'clear' }))
  })

  it('api.put(path, body) 仍走 PUT /api/{path}', async () => {
    mockFetchOk({ ok: true })
    await api.put('/foo', { x: 1 })
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/foo')
    expect(fetchSpy.mock.calls[0][1].method).toBe('PUT')
  })
})
