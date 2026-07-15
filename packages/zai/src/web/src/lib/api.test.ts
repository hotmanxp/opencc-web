import { beforeEach, describe, expect, test, vi } from 'vitest'

const notifMock = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('antd', () => ({ notification: notifMock }))

import { api } from './api.js'
import { ApiError } from './apiError.js'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function jsonResponse(status: number, body: unknown) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('api request', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    notifMock.error.mockReset()
    notifMock.error.mockImplementation(() => undefined)
  })

  test('成功 get 返回 JSON', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { a: 1 }))
    const r = await api.get<{ a: number }>('/foo')
    expect(r).toEqual({ a: 1 })
    expect(notifMock.error).not.toHaveBeenCalled()
  })

  test('失败抛 ApiError 并触发 notify', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { error: 'bad gateway' }))
    await expect(api.get('/system')).rejects.toBeInstanceOf(ApiError)
    expect(notifMock.error).toHaveBeenCalledTimes(1)
  })

  test('错误体读取并写入 ApiError.body(非 JSON 走 text)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('plain text error', { status: 500 }),
    )
    try {
      await api.get('/x')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(500)
      expect((err as ApiError).body).toBe('plain text error')
    }
  })

  test('post 序列化 JSON body 并设置 Content-Type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    await api.post('/x', { a: 1 })
    const init = fetchMock.mock.calls[0][1]
    expect(JSON.parse(init.body)).toEqual({ a: 1 })
    expect(init.headers['Content-Type']).toBe('application/json')
  })
})
