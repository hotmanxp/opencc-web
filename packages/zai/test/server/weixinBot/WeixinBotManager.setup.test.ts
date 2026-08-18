/**
 * WeixinBotManager QR 登录 wizard 测试。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const _tmpDir = mkdtempSync(join(tmpdir(), 'zai-weixin-setup-'))
process.env.ZAI_DATA_DIR = _tmpDir

import { WeixinBotManager } from '../../../src/server/services/weixinBot/WeixinBotManager.js'
import { WeixinAdapter } from '../../../src/server/services/weixinBot/WeixinAdapter.js'
import type { WeixinBotSettings } from '../../../src/shared/weixin.js'

interface QrResp { ret: number; errcode: number; [k: string]: unknown }

function mockFetchRouter(opts: {
  qrcode?: { qrcode_id?: string; qrcode_url?: string }
  qrcodeStatus?: { status?: string; account_id?: string; token?: string; base_url?: string }
  /** 之后 QR 状态跟随变化 */
  qrcodeStatusSequence?: Array<{ status?: string; account_id?: string; token?: string; base_url?: string }>
}): typeof fetch {
  let i = 0
  const seq = opts.qrcodeStatusSequence ?? (opts.qrcodeStatus ? [opts.qrcodeStatus] : [])
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }
    const url = String(input)
    if (url.includes('/getupdates')) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 100)
        t.unref?.()
      })
      return new Response(JSON.stringify({ ret: 0, errcode: 0, msgs: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/get_bot_qrcode')) {
      const body: QrResp = {
        ret: 0, errcode: 0,
        qrcode_id: opts.qrcode?.qrcode_id,
        qrcode_url: opts.qrcode?.qrcode_url,
      }
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/get_qrcode_status')) {
      const body = seq[i] ?? seq[seq.length - 1] ?? { ret: 0, errcode: 0, status: 'waiting' }
      i += 1
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ret: 0, errcode: 0 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

function makeManager(opts: {
  qrcode?: { qrcode_id?: string; qrcode_url?: string }
  qrcodeStatusSequence?: Array<{ status?: string; account_id?: string; token?: string; base_url?: string }>
  settings?: WeixinBotSettings | null
}) {
  const fetchImpl = mockFetchRouter({
    qrcode: opts.qrcode,
    qrcodeStatusSequence: opts.qrcodeStatusSequence,
  })
  const manager = new WeixinBotManager({
    getSettings: () => opts.settings ?? null,
    createAdapter: () => new WeixinAdapter({
      accountId: opts.settings?.accountId ?? 'pending',
      token: opts.settings?.token ?? 'pending',
      baseUrl: opts.settings?.baseUrl,
      cdnBaseUrl: opts.settings?.cdnBaseUrl,
      fetchImpl,
      mediaDir: mkdtempSync(join(tmpdir(), 'zai-setup-')),
    }),
  })
  return { manager, fetchImpl }
}

describe('WeixinBotManager — QR setup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('startSetup returns qrcodeId + qrcodeUrl (data URL) + pollUrl', async () => {
    const { manager } = makeManager({
      qrcode: { qrcode_id: 'qr-1', qrcode_url: 'https://wx.qq.com/qr/1.png' },
    })
    const r = await manager.startSetup()
    expect(r).not.toBeNull()
    expect(r!.qrcodeId).toBe('qr-1')
    // B7.3 修复后:qrcodeUrl 是 server-side 渲染的 PNG data URL (qrcode npm 库),
    // 不是原始 liteapp HTML URL (img tag 显示是 HTML 文档不是图片)。
    expect(r!.qrcodeUrl).toMatch(/^data:image\/png;base64,/)
    expect(r!.qrcodeUrl.length).toBeGreaterThan(100)
    expect(r!.pollUrl).toContain('/api/weixin/setup/poll')
    manager.cancelSetup()
  })

  it('startSetup returns null when no settings', async () => {
    const { manager } = makeManager({ settings: null })
    const r = await manager.startSetup()
    expect(r).toBeNull()
  })

  it('startSetup returns null when iLink returns empty', async () => {
    const { manager } = makeManager({ qrcode: {} })
    const r = await manager.startSetup()
    expect(r).toBeNull()
  })

  it('pollSetup returns waiting on initial state', async () => {
    const { manager } = makeManager({
      qrcode: { qrcode_id: 'qr-1', qrcode_url: 'https://wx.qq.com/qr/1.png' },
      qrcodeStatusSequence: [{ status: 'waiting' }],
    })
    await manager.startSetup()
    const s = await manager.pollSetup('qr-1')
    expect(s.status).toBe('waiting')
    manager.cancelSetup()
  })

  it('pollSetup on confirmed → persists accountId/token + reload', async () => {
    const { manager } = makeManager({
      qrcode: { qrcode_id: 'qr-1', qrcode_url: 'https://wx.qq.com/qr/1.png' },
      qrcodeStatusSequence: [{
        status: 'confirmed',
        account_id: 'a-real',
        token: 'tok-real',
        base_url: 'https://ilinkai.weixin.qq.com',
      }],
    })
    await manager.startSetup()
    const saveSpy = vi.spyOn(manager, 'saveAccount')
    const reloadSpy = vi.spyOn(manager, 'reload')
    const s = await manager.pollSetup('qr-1')
    expect(s.status).toBe('confirmed')
    expect(s.accountId).toBe('a-real')
    expect(saveSpy).toHaveBeenCalledWith('a-real', 'tok-real', 'https://ilinkai.weixin.qq.com')
    expect(reloadSpy).toHaveBeenCalled()
    expect(manager.getActiveSetup()).toBeNull()
  })

  it('pollSetup on expired → auto re-request (retry 1/3)', async () => {
    const { manager } = makeManager({
      qrcode: { qrcode_id: 'qr-1', qrcode_url: 'https://wx.qq.com/qr/1.png' },
      qrcodeStatusSequence: [{ status: 'expired' }],
    })
    await manager.startSetup()
    const s = await manager.pollSetup('qr-1')
    expect(s.status).toBe('expired')
    // 第二次 startSetup 会重新拿到 qrcode_id (mock 同一个)
    expect(manager.getActiveSetup()).not.toBeNull()
    expect(manager.getActiveSetup()!.retries).toBe(1)
  })

  it('cancelSetup clears activeSetup', async () => {
    const { manager } = makeManager({
      qrcode: { qrcode_id: 'qr-1', qrcode_url: 'https://wx.qq.com/qr/1.png' },
    })
    await manager.startSetup()
    expect(manager.getActiveSetup()).not.toBeNull()
    manager.cancelSetup()
    expect(manager.getActiveSetup()).toBeNull()
  })

  it('saveAccount persists to ~/.zai/weixin/accounts/<safe-id>.json', async () => {
    const { manager } = makeManager({})
    await manager.saveAccount('weird/id:test', 'tok-xyz', 'https://ilinkai.weixin.qq.com')
    const a = await manager.loadAccount('weird/id:test')
    expect(a?.token).toBe('tok-xyz')
    expect(a?.baseUrl).toBe('https://ilinkai.weixin.qq.com')
  })

  it('loadAccount returns null for unknown account', async () => {
    const { manager } = makeManager({})
    const a = await manager.loadAccount('nonexistent')
    expect(a).toBeNull()
  })
})
