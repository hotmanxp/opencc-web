import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ILinkClient } from '../../../src/server/services/weixinBot/iLinkClient.js'
import { ILinkGetUpdatesResponse } from '../../../src/server/services/weixinBot/iLinkTypes.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('ILinkClient', () => {
  let fetchImpl: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchImpl = vi.fn()
  })

  it('getUpdates parses msgs + syncs buf', async () => {
    const raw = {
      ret: 0,
      errcode: 0,
      msgs: [
        {
          message_id: 'm1',
          from_user_id: 'user_a',
          to_user_id: 'bot_x',
          msg_type: 1,
          item_list: [{ type: 1, text_item: { text: 'hi' } }],
        },
      ],
      longpolling_timeout_ms: 32000,
      get_updates_buf: 'cur_1',
    }
    fetchImpl.mockResolvedValueOnce(jsonResponse(raw))
    const c = new ILinkClient({ baseUrl: 'https://test.local', token: 'tk', fetchImpl: fetchImpl as unknown as typeof fetch })
    const got = await c.getUpdates('prev_0', 35_000)
    expect(ILinkGetUpdatesResponse.safeParse(got).success).toBe(true)
    expect(got.msgs).toHaveLength(1)
    expect(got.get_updates_buf).toBe('cur_1')
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://test.local/ilink/bot/getupdates')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({ get_updates_buf: 'prev_0' })
  })

  it('X-WECHAT-UIN is stable across requests (per session, derived from token)', async () => {
    // iLink 用 X-WECHAT-UIN 跟踪 bot session 身份 — 如果每请求 random,
    // iLink 把每次长轮询当成不同 client,session 永远绑不上 user → msgs=0
    // 反复直到 iLink 主动 -14 session timeout。回归保护:同一 token 下
    // 两次 getUpdates 发出的 X-WECHAT-UIN 必须一致;不同 token 之间必须不同。
    const empty = { ret: 0, errcode: 0, msgs: [], get_updates_buf: '' }
    // mockImplementation 每次返回新 Response,避免 Body 只能读一次
    fetchImpl.mockImplementation(async () => jsonResponse(empty))
    const c1 = new ILinkClient({ baseUrl: 'https://test.local', token: 'tk-A', fetchImpl: fetchImpl as unknown as typeof fetch })
    await c1.getUpdates('b1', 1000)
    await c1.getUpdates('b2', 1000)
    const uin1Req1 = (fetchImpl.mock.calls[0]![1] as RequestInit).headers!['X-WECHAT-UIN' as keyof HeadersInit]
    const uin1Req2 = (fetchImpl.mock.calls[1]![1] as RequestInit).headers!['X-WECHAT-UIN' as keyof HeadersInit]
    expect(typeof uin1Req1).toBe('string')
    expect(uin1Req1).toBe(uin1Req2) // 同一 token,同一 UIN

    // 不同 token → 不同 UIN,避免两个 bot 的 session 撞 UIN
    fetchImpl.mockClear()
    fetchImpl.mockImplementation(async () => jsonResponse(empty))
    const c2 = new ILinkClient({ baseUrl: 'https://test.local', token: 'tk-B', fetchImpl: fetchImpl as unknown as typeof fetch })
    await c2.getUpdates('b1', 1000)
    const uin2Req1 = (fetchImpl.mock.calls[0]![1] as RequestInit).headers!['X-WECHAT-UIN' as keyof HeadersInit]
    expect(uin2Req1).not.toBe(uin1Req1)
  })

  it('getUpdates abort within timeout returns empty msgs (long-poll normal)', async () => {
    fetchImpl.mockImplementationOnce(() => {
      const e = new Error('aborted')
      e.name = 'AbortError'
      return Promise.reject(e)
    })
    const c = new ILinkClient({ baseUrl: 'https://test.local', token: 'tk', fetchImpl: fetchImpl as unknown as typeof fetch })
    const got = await c.getUpdates('cur_0', 100)
    expect(got.ret).toBe(0)
    expect(got.msgs).toEqual([])
    expect(got.get_updates_buf).toBe('cur_0')
  })

  // BUG(2026-08-19)回归:实测 X-WECHAT-UIN 仅 getupdates 端点合法 —— bot 把
  // 这 header 加到所有 POST 上,sendmessage 因此被 iLink 返 ret:-2 "invalid
  // arguments",出站被静默拒。X-UIN 现在只在 getUpdates 路径发出。
  it('sendMessage / sendMediaMessage / sendTyping / getConfig / getUploadUrl / getBotQrcode do NOT include X-WECHAT-UIN', async () => {
    const ok = { ret: 0, errcode: 0 }
    fetchImpl.mockImplementation(async () => jsonResponse(ok))
    const c = new ILinkClient({ baseUrl: 'https://test.local', token: 'tk', fetchImpl: fetchImpl as unknown as typeof fetch })
    await c.sendMessage({ from_user_id: '', to_user_id: 'u1', client_id: 'c1', message_type: 2, content: { text: 't' } })
    await c.sendTyping('u1', 'tk1', 1)
    await c.getConfig('u1', null)
    await c.getUploadUrl()
    await c.getBotQrcode()
    for (const call of fetchImpl.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string> | undefined
      expect(headers?.['X-WECHAT-UIN']).toBeUndefined()
    }
  })

  it('sendMessage posts to sendmessage endpoint with base_info injected by post()', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse({ ret: 0, errcode: 0 }))
    const c = new ILinkClient({ baseUrl: 'https://test.local', token: 'tk', fetchImpl: fetchImpl as unknown as typeof fetch })
    // B7.6:caller 不再传 base_info,iLinkClient.post() 强制注入 { channel_version: '2.2.0' }
    await c.sendMessage({
      from_user_id: '',
      to_user_id: 'user_a',
      client_id: 'cid-1',
      message_type: 2,
      content: { text: 'hello', context_token: 'tok' },
    })
    const [, init] = fetchImpl.mock.calls[0]
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      to_user_id: 'user_a',
      content: { text: 'hello' },
      base_info: { channel_version: '2.2.0' },
    })
  })

  it('getBotQrcode returns parsed qrcode url', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      ret: 0,
      errcode: 0,
      qrcode_id: 'qr1',
      qrcode_url: 'https://wx.qq.com/qr/qr1.png',
    }))
    const c = new ILinkClient({ baseUrl: 'https://test.local', token: 'tk', fetchImpl: fetchImpl as unknown as typeof fetch })
    const got = await c.getBotQrcode()
    expect(got.qrcode_id).toBe('qr1')
    expect(got.qrcode_url).toContain('qr1.png')
  })

  it('getQrcodeStatus uses GET method + ?qrcode=<id> (NOT qrcode_id)', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      ret: 0,
      errcode: 0,
      status: 'wait', // iLink 真实字段值,不是 'waiting'
    }))
    const c = new ILinkClient({ baseUrl: 'https://test.local', token: 'tk', fetchImpl: fetchImpl as unknown as typeof fetch })
    const got = await c.getQrcodeStatus('qr1')
    expect(got.status).toBe('wait')
    const [url, init] = fetchImpl.mock.calls[0]
    expect((init as RequestInit).method).toBe('GET')
    // iLink 真实 schema: ?qrcode=<id>(不是 qrcode_id=),错传会让 iLink 返回 ret=1
    expect(String(url)).toContain('qrcode=qr1')
    expect(String(url)).not.toContain('qrcode_id=qr1')
    expect(String(url)).toContain('bot_type=3')
  })

  it('HTTP 500 throws with status + body preview', async () => {
    fetchImpl.mockResolvedValueOnce(new Response('internal error', { status: 500 }))
    const c = new ILinkClient({ baseUrl: 'https://test.local', token: 'tk', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(c.getConfig('user_a', null)).rejects.toThrow(/HTTP 500/)
  })
})
