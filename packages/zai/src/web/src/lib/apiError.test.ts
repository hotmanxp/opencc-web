import { vi } from 'vitest'
import { ApiError, notifyApiError, notifySseError, __resetThrottleForTests } from './apiError.js'

const notifMock = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('antd', () => ({ notification: notifMock }))

describe('ApiError', () => {
  test('字段赋值正确', () => {
    const e = new ApiError(502, 'GET', '/system', 'bad gateway')
    expect(e.status).toBe(502)
    expect(e.method).toBe('GET')
    expect(e.url).toBe('/system')
    expect(e.body).toBe('bad gateway')
    expect(e.name).toBe('ApiError')
    expect(e).toBeInstanceOf(Error)
  })

  test('message 携带 status + method + url', () => {
    const e = new ApiError(404, 'POST', '/agent/prompt', '')
    expect(e.message).toContain('404')
    expect(e.message).toContain('POST')
    expect(e.message).toContain('/agent/prompt')
  })

  test('at 是当前时间戳(ms)', () => {
    const before = Date.now()
    const e = new ApiError(500, 'GET', '/x', '')
    const after = Date.now()
    expect(e.at).toBeGreaterThanOrEqual(before)
    expect(e.at).toBeLessThanOrEqual(after)
  })
})

describe('notifyApiError', () => {
  beforeEach(() => {
    notifMock.error.mockReset()
    __resetThrottleForTests()
  })

  test('首次调用触发 antd notification.error,message 含 status+method+path,description 含 body+method+url+status,duration=6', () => {
    notifyApiError(new ApiError(502, 'GET', '/system', 'bad gateway'))
    expect(notifMock.error).toHaveBeenCalledTimes(1)
    const cfg = notifMock.error.mock.calls[0][0]
    expect(cfg.message).toContain('502')
    expect(cfg.message).toContain('GET')
    expect(cfg.message).toContain('/api/system')
    expect(cfg.duration).toBe(6)
    expect(typeof cfg.description).toBe('string')
    expect(cfg.description).toContain('GET')
    expect(cfg.description).toContain('/api/system')
    expect(cfg.description).toContain('502')
    expect(cfg.description).toContain('bad gateway')
  })

  test('同一 key 2000ms 内第二次调用被节流', () => {
    notifyApiError(new ApiError(502, 'GET', '/system', ''))
    notifyApiError(new ApiError(502, 'GET', '/system', ''))
    expect(notifMock.error).toHaveBeenCalledTimes(1)
  })

  test('不同 status 不节流', () => {
    notifyApiError(new ApiError(500, 'GET', '/x', ''))
    notifyApiError(new ApiError(502, 'GET', '/x', ''))
    expect(notifMock.error).toHaveBeenCalledTimes(2)
  })

  test('body 无法解析为 JSON 时,description 回退到原文(不被 [object Object] 替换)', () => {
    notifyApiError(new ApiError(500, 'GET', '/x', 'plain text error'))
    const cfg = notifMock.error.mock.calls[0][0]
    expect(cfg.description).toContain('plain text error')
    expect(cfg.description).not.toContain('[object')
  })
})

describe('notifySseError', () => {
  beforeEach(() => {
    notifMock.error.mockReset()
    __resetThrottleForTests()
  })

  test('弹出连接已断开 toast', () => {
    notifySseError('/install/resource?type=skills', '连接已断开')
    expect(notifMock.error).toHaveBeenCalledTimes(1)
    const cfg = notifMock.error.mock.calls[0][0]
    expect(cfg.message).toContain('SSE')
    expect(cfg.description).toContain('/install')
    expect(cfg.duration).toBe(6)
  })

  test('同 path 2000ms 内重复被节流', () => {
    notifySseError('/event', 'oops')
    notifySseError('/event', 'oops')
    expect(notifMock.error).toHaveBeenCalledTimes(1)
  })
})
