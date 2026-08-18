/**
 * WeixinAdapter 入站测试 — 覆盖 long-poll / dedup / access policy / 媒体下载。
 * 不依赖真实 iLink,把 fetch 注入成 mock,停在 inbound 路径。
 *
 * B1 阶段暂不注入 emitter 也不消费 outbound,只断言 _processMessage 通过
 * emitter 把 InternalWeixinMessage 派发出去(emitter 注入前 B1 阶段允许它什么都不做)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WeixinAdapter, type InternalWeixinMessage } from '../../../src/server/services/weixinBot/WeixinAdapter.js'

/**
 * Mock fetch that simulates long-poll: returns the supplied JSON body but
 * only after `holdMs` (default 200ms) so disconnect can fire abort and
 * unblock the poll loop. Tests that want immediate response pass holdMs=0.
 */
function mockFetchOk(json: unknown, holdMs = 200): typeof fetch {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, holdMs)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t)
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      }, { once: true })
    })
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

function mockFetchSeq(responses: unknown[], holdMs = 200): typeof fetch {
  let i = 0
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, holdMs)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t)
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      }, { once: true })
    })
    const body = responses[i] ?? responses[responses.length - 1]
    i += 1
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

function mockFetchImmediate(json: unknown): typeof fetch {
  return mockFetchOk(json, 0)
}

describe('WeixinAdapter — inbound', () => {
  let mediaDir: string
  beforeEach(() => {
    mediaDir = mkdtempSync(join(tmpdir(), 'zai-weixin-media-'))
  })

  it('connect → connected; disconnect → disconnected', async () => {
    const fetchImpl = mockFetchOk({ ret: 0, errcode: 0, msgs: [] })
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'token-a',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
    })
    expect(a.state()).toBe('disconnected')
    await a.connect()
    expect(a.state()).toBe('connected')
    await a.disconnect()
    expect(a.state()).toBe('disconnected')
  })

  it('emits inbound message for simple DM text', async () => {
    const internal: InternalWeixinMessage[] = []
    const fetchImpl = mockFetchSeq([{
      ret: 0, errcode: 0,
      msgs: [{
        message_id: 'm1',
        from_user_id: 'user_a',
        to_user_id: 'acct',
        msg_type: 1,
        context_token: 'CT',
        item_list: [{ type: 1, text_item: { text: 'hi' } }],
      }],
      get_updates_buf: 'buf-1',
    }], 0)
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'token-b',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
      dmPolicy: 'pairing',
    })
    a.setEmitter((msg) => internal.push(msg))
    await a.connect()
    // wait for one debounce flush (3s default)
    await new Promise((r) => setTimeout(r, 3500))
    await a.disconnect()
    expect(internal.length).toBeGreaterThan(0)
    const last = internal[internal.length - 1]
    expect(last.text).toBe('hi')
    expect(last.chatType).toBe('dm')
    expect(last.chatId).toBe('user_a')
    expect(last.senderId).toBe('user_a')
    expect(last.contextToken).toBe('CT')
  })

  it('dedup: same message_id twice only emits once', async () => {
    let count = 0
    const internal: InternalWeixinMessage[] = []
    const fetchImpl = mockFetchSeq([{
      ret: 0, errcode: 0,
      msgs: [{ message_id: 'dup', from_user_id: 'u', item_list: [{ type: 1, text_item: { text: 'x' } }] }],
    }], 0)
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'token-c',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
      dmPolicy: 'pairing',
    })
    a.setEmitter((msg) => { internal.push(msg); count += 1 })
    await a.connect()
    await new Promise((r) => setTimeout(r, 3500))
    await a.disconnect()
    expect(count).toBe(1)
  })

  it('dmPolicy=allowlist filters out non-listed senders', async () => {
    const internal: InternalWeixinMessage[] = []
    const fetchImpl = mockFetchOk({
      ret: 0, errcode: 0,
      msgs: [{ message_id: 'm1', from_user_id: 'eve', item_list: [{ type: 1, text_item: { text: 'hack' } }] }],
    })
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'token-d',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
      dmPolicy: 'allowlist',
      allowFrom: ['alice'],
    })
    a.setEmitter((msg) => internal.push(msg))
    await a.connect()
    await new Promise((r) => setTimeout(r, 3500))
    await a.disconnect()
    expect(internal).toEqual([])
  })

  it('groupPolicy=disabled drops group messages', async () => {
    const internal: InternalWeixinMessage[] = []
    const fetchImpl = mockFetchOk({
      ret: 0, errcode: 0,
      msgs: [{
        message_id: 'm1',
        from_user_id: 'user_a',
        room_id: 'room_42',
        msg_type: 1,
        item_list: [{ type: 1, text_item: { text: 'group msg' } }],
      }],
    })
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'token-e',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
      dmPolicy: 'pairing',
      groupPolicy: 'disabled',
    })
    a.setEmitter((msg) => internal.push(msg))
    await a.connect()
    await new Promise((r) => setTimeout(r, 3500))
    await a.disconnect()
    expect(internal).toEqual([])
  })

  it('session expired (-14) sets state=reconnecting and emits lastError', async () => {
    const fetchImpl = mockFetchOk({ ret: -14, errcode: -14, errmsg: 'expired' }, 50)
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'token-f',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
    })
    await a.connect()
    // 等待 mock fetch 50ms + 解析 + 短暂延迟
    await new Promise((r) => setTimeout(r, 200))
    expect(a.state()).toBe('reconnecting')
    expect(a.status().lastError).toMatch(/session expired/i)
    // 关闭:让 _pollLoop 退出 — mock fetch 50ms 后 resolve, abort 触发
    await a.disconnect()
  }, 10_000)
})
