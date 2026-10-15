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

  it('dedup: distinct message_id with identical text is NOT swallowed', async () => {
    // Regression: 内容指纹层 `content:<sender>:<md5(text)>` 把两条 message_id
    // 不同、文本相同的合法消息判成重复,第二条被静默丢弃。debounce 仍会把
    // 它们合并成一次 flush,所以断言的是「两个 fragment 都在」而不是「两条事件」。
    const internal: InternalWeixinMessage[] = []
    const fetchImpl = mockFetchSeq([{
      ret: 0, errcode: 0,
      msgs: [
        { message_id: 'x1', from_user_id: 'u', item_list: [{ type: 1, text_item: { text: 'ok' } }] },
        { message_id: 'x2', from_user_id: 'u', item_list: [{ type: 1, text_item: { text: 'ok' } }] },
      ],
    }], 0)
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'token-dedup2',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
      dmPolicy: 'pairing',
    })
    a.setEmitter((msg) => internal.push(msg))
    await a.connect()
    await new Promise((r) => setTimeout(r, 3500))
    await a.disconnect()
    expect(internal.length).toBe(1)
    expect(internal[0].text).toBe('ok\nok')
  })

  it('disconnect dispatches debounced text instead of dropping it', async () => {
    // Regression: 游标已推进,但 disconnect() 走 flushAll(drop) 把缓冲区直接丢掉
    // —— 消息既没派发也没落 pending,服务端不会重投,永久丢失。
    const internal: InternalWeixinMessage[] = []
    // 第一轮给一条纯文本(进 debounce 缓冲区),之后长轮询挂住不发新消息,
    // 避免 3s 静默期自然 flush 掩盖问题。
    const fetchImpl = mockFetchOk({ ret: 0, errcode: 0, msgs: [], get_updates_buf: 'buf-2' }, 0)
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'token-flush',
      baseUrl: 'https://test.local',
      fetchImpl,
      mediaDir,
      dmPolicy: 'pairing',
    })
    a.setEmitter((msg) => internal.push(msg))
    await a.connect()
    // 直接投一条走 _processMessage,避免依赖 mock 轮询时序
    await (a as unknown as { _processMessage(m: unknown): Promise<void> })._processMessage({
      message_id: 'f1',
      from_user_id: 'user_a',
      to_user_id: 'acct',
      msg_type: 1,
      context_token: 'CT',
      item_list: [{ type: 1, text_item: { text: 'buffered text' } }],
    })
    expect(internal).toEqual([])   // 还在缓冲区
    await a.disconnect()
    expect(internal.map((m) => m.text)).toEqual(['buffered text'])
  })

  it('同一 sessionKey 的多条消息合并成一次 flush 后,游标仍能落盘', async () => {
    // Regression: 早先用「入队 +1 / flush -1」的计数器判断「debounce 是否排空」。
    // 同一 sessionKey 的多条消息会**合并成一次** flush,计数器只减一次就停在
    // >0 —— 游标再也写不下去,一旦崩溃这批消息永久丢失。
    const saves: string[] = []
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'token-merge',
      baseUrl: 'https://test.local',
      fetchImpl: mockFetchOk({ ret: 0, errcode: 0, msgs: [] }, 0),
      mediaDir,
      dmPolicy: 'pairing',
    })
    const syncStore = (a as unknown as { syncStore: { save: (id: string, b: string) => Promise<void> } }).syncStore
    syncStore.save = async (_id, buf) => { saves.push(buf) }

    const internal: InternalWeixinMessage[] = []
    a.setEmitter((msg) => internal.push(msg))
    await a.connect()

    const proc = (a as unknown as { _processMessage(m: unknown): Promise<void> })._processMessage.bind(a)
    // 同一 sessionKey(同 sender)连发两条 → debounce 合并成一次 flush
    await proc({ message_id: 'm1', from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: 'a' } }] })
    await proc({ message_id: 'm2', from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: 'b' } }] })

    const advance = (a as unknown as { _advanceCursor(b: string): Promise<void> })._advanceCursor.bind(a)
    await advance('buf-merged')
    // 还在 debounce 窗口内 → 游标不能落盘
    expect(saves).toEqual([])

    // 走**自然**排空路径(静默期到期),不靠 disconnect 的兜底 clear ——
    // 否则 clear() 会掩盖「计数器停在 >0、游标再也写不下去」这个真 bug。
    await new Promise((r) => setTimeout(r, 3500))

    expect(internal.map((m) => m.text)).toEqual(['a\nb'])
    expect(saves).toEqual(['buf-merged'])

    await a.disconnect()
  })

  it('上一代迟到 settle 不会误删新一代的 pending 标记', async () => {
    // Regression(验证 agent 实测复现):debouncePendingKeys 原先按 key 记账。
    // 第 N-1 代的 emit promise 迟到 settle,其 .finally 里的 delete(sessionKey)
    // 会把第 N 代**刚加回来**的同一个 key 删掉 → Set 变空 → 游标被写下,
    // 而第 N 代消息还在缓冲区里没送达。崩溃即永久丢失(内存 dedup 让服务端
    // 重投变成 no-op)。修法:每个 key 记代号,settle 时只删自己那一代。
    const saves: string[] = []
    const a = new WeixinAdapter({
      accountId: 'acct',
      token: 'token-gen',
      baseUrl: 'https://test.local',
      fetchImpl: mockFetchOk({ ret: 0, errcode: 0, msgs: [] }, 0),
      mediaDir,
      dmPolicy: 'pairing',
    })
    const syncStore = (a as unknown as { syncStore: { save: (id: string, b: string) => Promise<void> } }).syncStore
    syncStore.save = async (_id, buf) => { saves.push(buf) }

    // 第一次 emit 慢(模拟 bridge.deliver 耗时),第二代入队会发生在它 settle 之前
    let releaseEmit: (() => void) | null = null
    const firstEmitStarted = new Promise<void>((r) => { releaseEmit = r })
    a.setEmitter(async (msg) => {
      if (msg.text === 'first') {
        releaseEmit?.()
        await new Promise((r) => setTimeout(r, 60))
      }
    })
    await a.connect()

    const proc = (a as unknown as { _processMessage(m: unknown): Promise<void> })._processMessage.bind(a)
    await proc({ message_id: 'g1', from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: 'first' } }] })
    // 等第一代进入 flush 并卡在慢 emit 上
    await firstEmitStarted
    // 第二代在第一代 settle 之前入队
    await proc({ message_id: 'g2', from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: 'second' } }] })

    const advance = (a as unknown as { _advanceCursor(b: string): Promise<void> })._advanceCursor.bind(a)
    await advance('buf-gen')

    // 等第一代那个 60ms 的慢 emit settle —— 跨代误删就发生在这一刻。
    // 必须等到它之后才断言:第二代仍在缓冲区(3s 静默期),游标不能落盘。
    await new Promise((r) => setTimeout(r, 400))
    expect(saves).toEqual([])

    // 让第二代自然排空
    await new Promise((r) => setTimeout(r, 3200))
    expect(saves).toEqual(['buf-gen'])

    await a.disconnect()
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
