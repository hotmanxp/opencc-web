import { describe, test, expect, vi } from 'vitest'
import type { Request } from 'express'
import { redirectMobileUA, matchesMobileUA } from '../../../middleware/redirectMobileUA.js'

function mkReq(path: string, ua: string | undefined): Request {
  return { path, url: path, originalUrl: path, baseUrl: '', headers: ua ? { 'user-agent': ua } : {} } as unknown as Request
}
function mkRes(): any {
  const headers: Record<string, string> = {}
  return {
    statusCode: 200,
    headers,
    setHeader(k: string, v: string) { headers[k] = v },
    getHeader(k: string) { return headers[k] },
    status(c: number) { this.statusCode = c; return this },
    redirect(c: number, loc: string) { this.statusCode = c; headers.location = loc; return this },
  }
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
    // Android + Mobile in UA string
    [
      'Mozilla/5.0 (Linux; Android 10; SM-G960U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.96 Mobile Safari/537.36',
      true,
    ],
    // iPhone + Mobile Safari
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 13_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Mobile/17A577 Safari/604.1',
      true,
    ],
    // Desktop Safari (no Mobile) — must NOT match to avoid false-positives
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      false,
    ],
  ])('UA=%s -> %s', (ua, expected) => {
    expect(matchesMobileUA(ua)).toBe(expected)
  })
})

describe('redirectMobileUA', () => {
  test('redirects /agent?sid=abc to /m?sid=abc (querystring preserved)', () => {
    const req = mkReq('/agent', 'Mozilla/5.0 (iPhone)')
    req.url = '/agent?sid=abc&foo=bar'
    req.originalUrl = '/agent?sid=abc&foo=bar'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/m?sid=abc&foo=bar')
    expect(next).not.toHaveBeenCalled()
  })

  test('does NOT redirect /login', () => {
    const req = mkReq('/login', 'Mozilla/5.0 (iPhone)')
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(res.statusCode).toBe(200)
    expect(next).toHaveBeenCalledOnce()
  })

  test('does NOT redirect /dashboard', () => {
    const req = mkReq('/dashboard', 'Mozilla/5.0 (iPhone)')
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  test('does NOT redirect /m (loop guard)', () => {
    const req = mkReq('/m', 'Mozilla/5.0 (iPhone)')
    req.url = '/m?sid=abc'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.headers.location).toBeUndefined()
  })

  test('does NOT redirect /agent when UA is desktop', () => {
    const req = mkReq('/agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    req.url = '/agent'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.headers.location).toBeUndefined()
  })

  test('does NOT redirect /agent when UA is undefined', () => {
    const req = mkReq('/agent', undefined)
    req.url = '/agent'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  test('redirects /agent/ with trailing slash (baseUrl mount scenario) for mobile UA', () => {
    // Simulates Express app.use('/agent', redirectMobileUA): baseUrl='/agent',
    // req.path='/' (stripped), req.url='/' (stripped), req.originalUrl is '/agent/...'.
    // /agent/ with mobile UA SHOULD redirect to /m/ — this was the original bug,
    // fixed by updating the path regex to /^\/agent(?:\?|\/|$)/.
    const req = mkReq('/', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
    ;(req as any).baseUrl = '/agent'
    req.originalUrl = '/agent?sid=abc&foo=bar'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/m?sid=abc&foo=bar')
  })

  test('does NOT redirect when baseUrl is mounted under non-/agent prefix', () => {
    // Even with iPhone UA, a mount like app.use('/api', redirectMobileUA)
    // must NOT redirect — the middleware is only meant to handle /agent.
    const req = mkReq('/agent/xxx', 'Mozilla/5.0 (iPhone)')
    ;(req as any).baseUrl = '/api'
    req.originalUrl = '/api/agent/xxx'
    const res = mkRes()
    const next = vi.fn()
    redirectMobileUA(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.headers.location).toBeUndefined()
  })
})
