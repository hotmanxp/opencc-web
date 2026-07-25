import { describe, test, expect, vi } from 'vitest'
import type { Request, Response } from 'express'
import { redirectMobileUA, matchesMobileUA } from './redirectMobileUA.js'

function mkReq(path: string, ua: string | undefined): Request {
  return { path, url: path, headers: ua ? { 'user-agent': ua } : {} } as unknown as Request
}
function mkRes(): Response {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v },
    getHeader(k: string) { return this.headers[k] },
    status(c: number) { this.statusCode = c; return this },
    redirect(c: number, loc: string) { this.statusCode = c; this.headers['location'] = loc; return this },
  }
  return res as Response
}

describe('matchesMobileUA', () => {
  test.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', true],
    ['Mozilla/5.0 (Linux; Android 13; Pixel 7)', true],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', true],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', false],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', false],
    ['', false],
    [undefined, false],
  ])('UA=%s -> %s', (ua, expected) => {
    expect(matchesMobileUA(ua)).toBe(expected)
  })
})

describe('redirectMobileUA', () => {
  test('redirects /agent?sid=abc to /m?sid=abc', () => {
    const req = mkReq('/agent', 'Mozilla/5.0 (iPhone')
    ;(req as any).url = '/agent?sid=abc&foo=bar'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('/m?sid=abc&foo=bar')
    expect(next).not.toHaveBeenCalled()
  })

  test('does NOT redirect /login', () => {
    const req = mkReq('/login', 'Mozilla/5.0 (iPhone')
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(res.statusCode).toBe(200)
    expect(next).toHaveBeenCalledOnce()
  })

  test('does NOT redirect /dashboard', () => {
    const req = mkReq('/dashboard', 'Mozilla/5.0 (iPhone')
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  test('does NOT redirect /m (loop guard)', () => {
    const req = mkReq('/m', 'Mozilla/5.0 (iPhone')
    ;(req as any).url = '/m?sid=abc'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.headers['location']).toBeUndefined()
  })

  test('does NOT redirect /agent when UA is desktop', () => {
    const req = mkReq('/agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7')
    ;(req as any).url = '/agent'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.headers['location']).toBeUndefined()
  })

  test('does NOT redirect /agent when UA is undefined', () => {
    const req = mkReq('/agent', undefined)
    ;(req as any).url = '/agent'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })
})
