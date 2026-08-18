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
  // createAdapter 必须接受 manager 传入的 settings(可能来自 lastConfirmedCreds
  // fallback,不是 opts.settings),不能用外层 opts 兜底 — 否则测试验不了
  // QR wizard → reload → start 用 confirmed token connect 的真实路径。
  const manager = new WeixinBotManager({
    getSettings: () => opts.settings ?? null,
    createAdapter: (s) => new WeixinAdapter({
      accountId: s.accountId ?? 'pending',
      token: s.token ?? 'pending',
      baseUrl: s.baseUrl,
      cdnBaseUrl: s.cdnBaseUrl,
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

  // B7.5:复现"扫码通过后页面一直等待"。确认 + 自动 reload 之后,manager
  // 状态必须变成 connected(否则前端 status 一直 unconfigured,fail 看到 QR
  // 重置回"连接微信"按钮)。当前实现里 deps.getSettings 永远返回 null,reload
  // → start 读到 null → unconfigured,前端就掉回"未配置"分支。
  it('pollSetup confirmed → manager reload → state should reach connected (B7.5 regression)', async () => {
    // 每个 case 用 unique token 避免 proper-lockfile 与同 test file 内 lock 互踩。
    const tok = `tok-b75-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { manager } = makeManager({
      qrcode: { qrcode_id: 'qr-1', qrcode_url: 'https://wx.qq.com/qr/1.png' },
      qrcodeStatusSequence: [{
        status: 'confirmed',
        account_id: 'a-real',
        token: tok,
        base_url: 'https://ilinkai.weixin.qq.com',
      }],
      // 注意:这是默认 settings=null —— QR 登录 wizard 应该能凭 accounts/<id>.json
      // 启动 adapter,不应该依赖 settings.weixinBot.accountId/token。
      settings: null,
    })
    await manager.startSetup()
    const r = await manager.pollSetup('qr-1')
    expect(r.status).toBe('confirmed')
    // 等待 reload 内部 start 异步完成
    await new Promise((resolve) => setTimeout(resolve, 50))
    const st = manager.status()
    if (st.state !== 'connected') {
      throw new Error(`expected connected, got state=${st.state} lastError=${st.lastError ?? '<none>'} configured=${st.configured} accountId=${st.accountId ?? '<none>'}`)
    }
    expect(st.state).toBe('connected')
    expect(st.configured).toBe(true)
    expect(st.accountId).toBe('a-real')
    await manager.stop()
  })
})
