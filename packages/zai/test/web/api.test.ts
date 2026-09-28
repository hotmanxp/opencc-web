// packages/zai/test/web/api.test.ts
//
// `api.get/post/put` (`web/src/lib/api.ts`) 必须把第二个 init 参数透传给
// fetch。曾经的实现 `get: <T>(path: string) => request<T>('GET', path)` 漏掉
// 了 init —— 调用方用 `as RequestInit` 断言传第二个参数时 TS 放行、运行时
// 静默丢弃,导致 `aaApi` 的配对链路(getStatus / getConfig / getPairingStatus)
// 拿不到 `X-Zai-Token` header。这条链路里 status 端点恰好不鉴权,GET 看起来
// "没事",所以 bug 长期未被发现,直到手动验证才暴露。
//
// 锁定: get 必须接受可选 init,post/put 维持原有语义。所有 init.headers 必须
// 出现在 fetch 调用上,Content-Type 仍由 request 内部注入(不覆盖)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api } from '../../src/web/src/lib/api.js'

type FetchCall = { url: string; init: RequestInit }

let calls: FetchCall[] = []

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  calls = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.stubGlobal('fetch', (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return okJson({ ok: true })
  }) as unknown as typeof fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web/lib/api init passthrough', () => {
  it('api.get with no init still works (1-arg call signature)', async () => {
    await api.get('/api/probe')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/probe')
    expect(calls[0]!.init.method).toBe('GET')
  })

  it('api.get forwards init.headers to fetch (the original bug)', async () => {
    await api.get('/api/probe', {
      headers: { 'X-Zai-Token': 'cxt_abc123' },
    })
    expect(calls).toHaveLength(1)
    const sent = calls[0]!.init.headers as Record<string, string>
    // 必须包含调用方传的 token —— 旧实现会静默丢失这一项
    expect(sent['X-Zai-Token']).toBe('cxt_abc123')
    // Content-Type 由 request 内部注入,调用方没传也要有
    expect(sent['Content-Type']).toBe('application/json')
  })

  it('api.get forwards init.method when provided (defensive)', async () => {
    // 罕见但合法:init.method 应被保留为 fallback,request 自身的 method 参数
    // 优先。但 get 调用只传 method='GET' 给 request,所以这里只断言最终
    // 落到 fetch 上的是 GET,没有意外覆盖。
    await api.get('/api/probe', { method: 'GET' })
    expect(calls[0]!.init.method).toBe('GET')
  })

  it('api.post forwards body + init.headers', async () => {
    await api.post('/api/probe', { a: 1 }, { headers: { 'X-Zai-Token': 't' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.body).toBe(JSON.stringify({ a: 1 }))
    const sent = calls[0]!.init.headers as Record<string, string>
    expect(sent['X-Zai-Token']).toBe('t')
  })

  it('api.put forwards body and uses PUT method', async () => {
    await api.put('/api/probe', { a: 1 })
    expect(calls[0]!.init.method).toBe('PUT')
    expect(calls[0]!.init.body).toBe(JSON.stringify({ a: 1 }))
  })

  it('init.headers may override the injected Content-Type (documented behavior)', async () => {
    // `request` 的 spread 是 `{ 'Content-Type': 'application/json', ...init?.headers }`,
    // 所以调用方传的 `Content-Type` 会**覆盖**默认。这是当前行为,虽然
    // `api.ts` 注释里写"调用方传进来的 headers 不会覆盖 Content-Type"——那个
    // 注释说的是调用方**没传**的情况(默认 application/json 自动注入)。
    // 这里锁住真实行为,免得哪天有人改了 spread 顺序默默回归。
    await api.get('/api/probe', {
      headers: { 'Content-Type': 'text/plain' },
    })
    const sent = calls[0]!.init.headers as Record<string, string>
    expect(sent['Content-Type']).toBe('text/plain')
  })

  it('when init.headers omits Content-Type, request injects application/json', async () => {
    await api.get('/api/probe', { headers: { 'X-Zai-Token': 't' } })
    const sent = calls[0]!.init.headers as Record<string, string>
    expect(sent['Content-Type']).toBe('application/json')
    expect(sent['X-Zai-Token']).toBe('t')
  })
})