/**
 * WeixinAdapter 出站测试 — 覆盖 sendText / 重试 / 限流熔断 / sendTyping / 媒体上传。
 *
 * Mock 路由:URL 包含 /getupdates → empty msgs (200ms hold 让 _pollLoop 不死循环);
 * URL 不包含 /getupdates → 走 responses 队列。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WeixinAdapter } from '../../../src/server/services/weixinBot/WeixinAdapter.js'

function mockFetchRouter(opts: {
  /** 顺序消费,每次 fetchImpl 调用取下一个 (非 /getupdates 路径) */
  responses?: unknown[]
  /** getupdates hold 时长,默认 100ms 让 _pollLoop 不死循环 */
  updateHoldMs?: number
  /** 自定义路由(mockSendImageFile 等) */
  customRoutes?: (url: string, init?: RequestInit) => Promise<Response> | null
}): typeof fetch {
  const responses = opts.responses ?? []
  let i = 0
  const updateHoldMs = opts.updateHoldMs ?? 100
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }
    const url = String(input)
    if (url.includes('/getupdates')) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, updateHoldMs)
        t.unref?.()
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        }, { once: true })
      })
      return new Response(JSON.stringify({ ret: 0, errcode: 0, msgs: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (opts.customRoutes) {
      const r = await opts.customRoutes(url, init)
      if (r) return r
    }
    const body = responses[i] ?? responses[responses.length - 1] ?? { ret: 0, errcode: 0 }
    i += 1
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

/** 取 fetchImpl 调用过的 /sendmessage URL 计数(忽略 getupdates 等) */
function countSendMessageCalls(fetchImpl: { mock: { calls: unknown[][] } }): number {
  return fetchImpl.mock.calls.filter((c) => String(c[0]).includes('/sendmessage')).length
}

describe('WeixinAdapter — outbound sendText', () => {
  let mediaDir: string
  beforeEach(() => {
    mediaDir = mkdtempSync(join(tmpdir(), 'zai-weixin-out-'))
  })

  it('sendText posts single chunk when short', async () => {
    const fetchImpl = mockFetchRouter({ responses: [{ ret: 0, errcode: 0 }] })
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'tk',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
      sendChunkDelaySeconds: 0,
    })
    await a.connect()
    const r = await a.sendText('user_a', 'hello')
    expect(r.success).toBe(true)
    expect(r.clientId).toBeDefined()
    expect(countSendMessageCalls(fetchImpl)).toBe(1)
    await a.disconnect()
  })

  it('sendText splits long text into multiple chunks', async () => {
    const fetchImpl = mockFetchRouter({
      responses: [
        { ret: 0, errcode: 0 },
        { ret: 0, errcode: 0 },
        { ret: 0, errcode: 0 },
      ],
    })
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'tk',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
      sendChunkDelaySeconds: 0,
    })
    await a.connect()
    const longText = 'A'.repeat(8500) // 一个 4000 上限 → 至少 3 chunks
    const r = await a.sendText('user_a', longText)
    expect(r.success).toBe(true)
    expect(countSendMessageCalls(fetchImpl)).toBe(3)
    await a.disconnect()
  })

  it('session expired (-14) triggers tokenless retry', async () => {
    const fetchImpl = mockFetchRouter({
      responses: [
        { ret: -14, errcode: -14, errmsg: 'session expired' },
        { ret: 0, errcode: 0 }, // tokenless 重试 OK
      ],
    })
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'tk',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
      sendChunkDelaySeconds: 0,
      sendChunkRetries: 3,
    })
    await a.connect()
    const r = await a.sendText('user_a', 'hi')
    expect(r.success).toBe(true)
    expect(countSendMessageCalls(fetchImpl)).toBe(2)
    await a.disconnect()
  })

  it('rate limit (-2) opens circuit and subsequent sends fail fast', async () => {
    const fetchImpl = mockFetchRouter({
      responses: [{ ret: -2, errcode: -2, errmsg: 'rate limited' }],
    })
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'tk',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
      sendChunkDelaySeconds: 0,
      sendChunkRetries: 0,
      rateLimitCircuitThreshold: 1,
      rateLimitCircuitOpenSeconds: 30,
    })
    await a.connect()
    const r = await a.sendText('user_a', 'hi')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/rate/)
    await a.disconnect()
  })

  it('exhausted retries returns error', async () => {
    const fetchImpl = mockFetchRouter({
      responses: [
        { ret: -1, errcode: -1, errmsg: 'transient' },
        { ret: -1, errcode: -1, errmsg: 'transient' },
      ],
    })
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'tk',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
      sendChunkDelaySeconds: 0,
      sendChunkRetries: 0,
    })
    await a.connect()
    const r = await a.sendText('user_a', 'hi')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/error|unknown|failed/)
    await a.disconnect()
  })

  it('sendText before connect returns error', async () => {
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'tk',
      baseUrl: 'https://test.local',
      fetchImpl: mockFetchRouter({ responses: [] }),
      mediaDir,
    })
    const r = await a.sendText('user_a', 'hi')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not connected/)
  })
})

describe('WeixinAdapter — outbound sendImageFile', () => {
  let mediaDir: string
  beforeEach(() => {
    mediaDir = mkdtempSync(join(tmpdir(), 'zai-weixin-img-'))
  })

  it('uploads encrypted file + posts sendmessage', async () => {
    const imagePath = join(mediaDir, 'test.png')
    writeFileSync(imagePath, Buffer.from('fake-image-bytes-here'))

    const seen = { uploadBody: null as Uint8Array | null }
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        const e = new Error('aborted')
        e.name = 'AbortError'
        throw e
      }
      const url = String(input)
      if (url.includes('/getupdates')) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 100)
          t.unref?.()
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(t)
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          }, { once: true })
        })
        return new Response(JSON.stringify({ ret: 0, errcode: 0, msgs: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/upload')) {
        seen.uploadBody = (init?.body as Uint8Array) ?? null
        return new Response('', {
          status: 200,
          headers: { 'x-encrypted-param': 'encrypted-param-xyz' },
        })
      }
      if (url.includes('/getuploadurl')) {
        return new Response(JSON.stringify({
          ret: 0, errcode: 0,
          upload_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload',
          encrypted_query_param: 'eq-param',
          filekey: 'fk',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ret: 0, errcode: 0 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'tk',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
    })
    await a.connect()
    const r = await a.sendImageFile('user_a', imagePath)
    expect(r.success).toBe(true)
    expect(seen.uploadBody).not.toBeNull()
    expect(seen.uploadBody!.length).toBeGreaterThanOrEqual(16)
    expect(seen.uploadBody!.length % 16).toBe(0) // AES-128-ECB + PKCS#7
    await a.disconnect()
  })

  it('upload HTTP 500 returns error', async () => {
    const imagePath = join(mediaDir, 'test.png')
    writeFileSync(imagePath, Buffer.from('data'))
    const fetchImpl = mockFetchRouter({
      updateHoldMs: 100,
      customRoutes: (url) => {
        if (url.includes('/upload')) {
          return Promise.resolve(new Response('boom', { status: 500 }))
        }
        if (url.includes('/getuploadurl')) {
          return Promise.resolve(new Response(JSON.stringify({
            ret: 0, errcode: 0,
            upload_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload',
            encrypted_query_param: 'eq',
            filekey: 'fk',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        }
        return null
      },
    })

    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'tk',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
    })
    await a.connect()
    const r = await a.sendImageFile('user_a', imagePath)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/HTTP 500|upload/i)
    await a.disconnect()
  })
})

describe('WeixinAdapter — sendTyping', () => {
  let mediaDir: string
  beforeEach(() => {
    mediaDir = mkdtempSync(join(tmpdir(), 'zai-weixin-typing-'))
  })

  it('fetches typing_ticket via getConfig on cache miss', async () => {
    const seen = { configCalled: false, sendTypingCalled: false }
    const fetchImpl = mockFetchRouter({
      updateHoldMs: 100,
      customRoutes: (url) => {
        if (url.includes('/getconfig')) {
          seen.configCalled = true
          return Promise.resolve(new Response(JSON.stringify({ ret: 0, errcode: 0, typing_ticket: 'ticket-abc' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }))
        }
        if (url.includes('/sendtyping')) {
          seen.sendTypingCalled = true
          return Promise.resolve(new Response(JSON.stringify({ ret: 0, errcode: 0 }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }))
        }
        return null
      },
    })
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'tk',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
    })
    await a.connect()
    await a.sendTyping('user_a', 'start')
    expect(seen.configCalled).toBe(true)
    expect(seen.sendTypingCalled).toBe(true)
    await a.disconnect()
  })
})
