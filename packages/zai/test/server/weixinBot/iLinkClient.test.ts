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

  it('sendMessage posts to sendmessage endpoint with base_info', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse({ ret: 0, errcode: 0 }))
    const c = new ILinkClient({ baseUrl: 'https://test.local', token: 'tk', fetchImpl: fetchImpl as unknown as typeof fetch })
    await c.sendMessage({
      from_user_id: '',
      to_user_id: 'user_a',
      client_id: 'cid-1',
      message_type: 2,
      content: { text: 'hello', context_token: 'tok' },
      base_info: { ilink_app_id: 'bot', ilink_app_client_version: '0x020200' },
    })
    const [, init] = fetchImpl.mock.calls[0]
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      to_user_id: 'user_a',
      content: { text: 'hello' },
      base_info: { ilink_app_id: 'bot' },
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

  it('getQrcodeStatus uses GET method', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse({
      ret: 0,
      errcode: 0,
      status: 'scanned',
    }))
    const c = new ILinkClient({ baseUrl: 'https://test.local', token: 'tk', fetchImpl: fetchImpl as unknown as typeof fetch })
    const got = await c.getQrcodeStatus('qr1')
    expect(got.status).toBe('scanned')
    const [url, init] = fetchImpl.mock.calls[0]
    expect((init as RequestInit).method).toBe('GET')
    expect(url).toContain('qrcode_id=qr1')
  })

  it('HTTP 500 throws with status + body preview', async () => {
    fetchImpl.mockResolvedValueOnce(new Response('internal error', { status: 500 }))
    const c = new ILinkClient({ baseUrl: 'https://test.local', token: 'tk', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(c.getConfig('user_a', null)).rejects.toThrow(/HTTP 500/)
  })
})
