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
  createAdapter?: (s: WeixinBotSettings) => WeixinAdapter
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
    createAdapter: opts.createAdapter ?? ((s) => new WeixinAdapter({
      accountId: s.accountId ?? 'pending',
      token: s.token ?? 'pending',
      baseUrl: s.baseUrl,
      cdnBaseUrl: s.cdnBaseUrl,
      fetchImpl,
      mediaDir: mkdtempSync(join(tmpdir(), 'zai-setup-')),
    })),
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
    expect(saveSpy).toHaveBeenCalledWith('a-real', 'tok-real', 'https://ilinkai.weixin.qq.com', undefined)
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

  // B7.5 修复:扫描通过后,即使 deps.getSettings() 返回的 settings.json 里
  // 还有旧的 accountId+token(用户之前手动配过),iLink 给的新 bot_token +
  // ilink_user_id 必须覆盖。否则 adapter 用旧 token 调 getUpdates,iLink 把
  // session 当成未绑定的 user → ret=0 msgs=0,UI 一直 connected 但收不到消息。
  it('pollSetup confirmed → new token + ilinkUserId override stale settings.json', async () => {
    const tok = `tok-ovr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // 模拟生产场景:settings.json 已有 weixinBot 配置(手动配过,token 已过期)
    const staleSettings: WeixinBotSettings = {
      enabled: true,
      accountId: 'old_acct@im.bot',
      token: 'stale_old_token_xxx',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'pairing',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      textBatchDelaySeconds: 3.0,
      sendChunkDelaySeconds: 1.5,
      rateLimitCircuitOpenSeconds: 30.0,
    }
    // createAdapter spy 用来捕获 reload → start 时 manager 传给 factory 的
    // settings,确认 ilinkUserId + 新 token 真的进了 adapter。
    // fetchImpl 必须能正确返 get_qrcode_status=confirmed,否则 reload 不会触发。
    const spyFetch = mockFetchRouter({
      qrcode: { qrcode_id: 'qr-1', qrcode_url: 'https://wx.qq.com/x.png' },
      qrcodeStatusSequence: [{
        status: 'confirmed',
        ilink_bot_id: 'new_acct@im.bot',
        bot_token: tok,
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: 'o9cq805tXobyYY0PdSQvXYvkV1Bg@im.wechat',
      }],
    })
    const createAdapterSpy = vi.fn((s: WeixinBotSettings) => new WeixinAdapter({
      accountId: s.accountId ?? 'pending',
      token: s.token ?? 'pending',
      baseUrl: s.baseUrl,
      cdnBaseUrl: s.cdnBaseUrl,
      ilinkUserId: s.ilinkUserId,
      fetchImpl: spyFetch,
      mediaDir: mkdtempSync(join(tmpdir(), 'zai-stale-')),
    }))
    const { manager } = makeManager({
      qrcode: { qrcode_id: 'qr-1', qrcode_url: 'https://wx.qq.com/qr/1.png' },
      qrcodeStatusSequence: [{
        status: 'confirmed',
        // iLink confirmed 响应(真实 schema 是 ilink_bot_id + bot_token + ilink_user_id)
        ilink_bot_id: 'new_acct@im.bot',
        bot_token: tok,
        baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: 'o9cq805tXobyYY0PdSQvXYvkV1Bg@im.wechat',
      }],
      settings: staleSettings,
      createAdapter: createAdapterSpy,
    })
    await manager.startSetup()
    await manager.pollSetup('qr-1')
    await new Promise((resolve) => setTimeout(resolve, 50))
    // reload → start 调用 createAdapter,捕获最后一次调用(应该是 reload 后的)
    expect(createAdapterSpy).toHaveBeenCalled()
    const passed = createAdapterSpy.mock.calls[createAdapterSpy.mock.calls.length - 1]![0]
    expect(passed.accountId).toBe('new_acct@im.bot')     // 新 accountId 覆盖
    expect(passed.token).toBe(tok)                       // 新 token 覆盖
    expect(passed.ilinkUserId).toBe('o9cq805tXobyYY0PdSQvXYvkV1Bg@im.wechat') // ilinkUserId 必须传,否则 getUpdates 不带 user_id,iLink session 不绑定 user
    expect(passed.dmPolicy).toBe('pairing')              // settings.json 里的策略保留
    await manager.stop()
  })
})
