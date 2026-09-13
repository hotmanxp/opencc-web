/**
 * Weixin REST API routes test (supertest).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 ZAI_DATA_DIR
const _tmpDir = mkdtempSync(join(tmpdir(), 'zai-weixin-api-'))
process.env.ZAI_DATA_DIR = _tmpDir
// P5:owner 锁是机器级的 → 测试隔离。
process.env.ZAI_WEIXIN_OWNER_LOCK_DIR = mkdtempSync(join(tmpdir(), 'zai-weixin-api-owner-'))
// P6:路由对非受管进程返回 409;测试声明自己是受管进程。
process.env.ZAI_SUPERVISOR_PID = String(process.pid)

// 在 import 之前先 mock WeixinBotManager,避免 initAgentRuntime 副作用
vi.mock('../../../src/server/services/weixinBot/WeixinBotManager.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/server/services/weixinBot/WeixinBotManager.js')>(
    '../../../src/server/services/weixinBot/WeixinBotManager.js',
  )
  return {
    ...actual,
    getWeixinBotManager: () => mockManager,
  }
})

let mockManager: any

import { weixinRouter } from '../../../src/server/routes/weixin.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/weixin', weixinRouter)
  return app
}

function makeMockManager() {
  const status = {
    configured: false,
    enabled: false,
    state: 'unconfigured',
    owner: false,
    ownerInfo: null,
    metrics: { inbound: 0, outbound: 0, pendingReplay: 0, pairingPending: 0, boundSessions: 0 },
  }
  return {
    status: vi.fn(() => status),
    statusAsync: vi.fn(async () => status),
    state: vi.fn(() => 'unconfigured'),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    saveAccount: vi.fn(async () => undefined),
    getAdapter: vi.fn(() => null),
    readOwner: vi.fn(async () => null),
    forceTakeoverOwner: vi.fn(async () => ({ ok: true, reason: 'cleared' })),
    listSessionBindings: vi.fn(async () => []),
    startSetup: vi.fn(async () => ({
      qrcodeId: 'qr-1',
      qrcodeUrl: 'https://wx.qq.com/qr/1.png',
      pollUrl: '/api/weixin/setup/poll?qrcodeId=qr-1',
    })),
    pollSetup: vi.fn(async () => ({ status: 'waiting' })),
    cancelSetup: vi.fn(() => undefined),
  }
}

describe('weixin routes', () => {
  beforeEach(async () => {
    mockManager = makeMockManager()
    // 清掉上一个用例可能残留的配对 / owner 状态
    const { getWeixinPairingStore, resetWeixinPairingStoreForTests } = await import(
      '../../../src/server/services/weixinBot/WeixinPairingStore.js'
    )
    await getWeixinPairingStore().list()
    resetWeixinPairingStoreForTests()
  })

  it('GET /api/weixin/status returns 200 with status', async () => {
    const app = makeApp()
    const res = await request(app).get('/api/weixin/status')
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('unconfigured')
    expect(mockManager.statusAsync).toHaveBeenCalled()
  })

  it('POST /api/weixin/connect calls manager.start', async () => {
    const app = makeApp()
    const res = await request(app).post('/api/weixin/connect').send({})
    expect(res.status).toBe(200)
    expect(mockManager.start).toHaveBeenCalled()
  })

  it('POST /api/weixin/connect returns 409 when not supervisor-managed', async () => {
    const prev = process.env.ZAI_SUPERVISOR_PID
    delete process.env.ZAI_SUPERVISOR_PID
    try {
      const app = makeApp()
      const res = await request(app).post('/api/weixin/connect').send({})
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('supervisor_required')
      expect(mockManager.start).not.toHaveBeenCalled()
    } finally {
      process.env.ZAI_SUPERVISOR_PID = prev
    }
  })

  it('POST /api/weixin/disconnect calls manager.stop', async () => {
    const app = makeApp()
    const res = await request(app).post('/api/weixin/disconnect').send({})
    expect(res.status).toBe(200)
    expect(mockManager.stop).toHaveBeenCalled()
  })

  it('POST /api/weixin/reload calls manager.reload', async () => {
    const app = makeApp()
    const res = await request(app).post('/api/weixin/reload').send({})
    expect(res.status).toBe(200)
    expect(mockManager.reload).toHaveBeenCalled()
  })

  it('GET /api/weixin/setup/poll requires qrcodeId', async () => {
    const app = makeApp()
    const res = await request(app).get('/api/weixin/setup/poll')
    expect(res.status).toBe(400)
  })

  it('POST /api/weixin/setup/confirm validates body', async () => {
    const app = makeApp()
    const res = await request(app).post('/api/weixin/setup/confirm').send({})
    expect(res.status).toBe(400)
  })

  it('POST /api/weixin/setup/confirm persists account + reload', async () => {
    const app = makeApp()
    const res = await request(app).post('/api/weixin/setup/confirm').send({
      accountId: 'acct1',
      token: 'tok-xyz',
    })
    expect(res.status).toBe(200)
    expect(mockManager.saveAccount).toHaveBeenCalledWith('acct1', 'tok-xyz', undefined)
    expect(mockManager.reload).toHaveBeenCalled()
  })

  it('POST /api/weixin/setup/start returns 502 when manager returns null', async () => {
    mockManager.startSetup.mockResolvedValue(null)
    const app = makeApp()
    const res = await request(app).post('/api/weixin/setup/start').send({})
    expect(res.status).toBe(502)
  })

  it('POST /api/weixin/setup/start returns qrcodeId + qrcodeUrl on success', async () => {
    mockManager.startSetup.mockResolvedValue({
      qrcodeId: 'qr-1',
      qrcodeUrl: 'https://wx.qq.com/qr/1.png',
      pollUrl: '/api/weixin/setup/poll?qrcodeId=qr-1',
    })
    const app = makeApp()
    const res = await request(app).post('/api/weixin/setup/start').send({})
    expect(res.status).toBe(200)
    expect(res.body.qrcodeId).toBe('qr-1')
    expect(res.body.qrcodeUrl).toBe('https://wx.qq.com/qr/1.png')
  })

  it('GET /api/weixin/setup/poll returns status from manager', async () => {
    mockManager.pollSetup.mockResolvedValue({
      status: 'scanned',
      accountId: 'a1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    })
    const app = makeApp()
    const res = await request(app).get('/api/weixin/setup/poll?qrcodeId=qr-1')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('scanned')
    expect(res.body.accountId).toBe('a1')
    expect(mockManager.pollSetup).toHaveBeenCalledWith('qr-1')
  })

  it('POST /api/weixin/setup/cancel returns cancelled', async () => {
    const app = makeApp()
    const res = await request(app).post('/api/weixin/setup/cancel').send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('cancelled')
    expect(mockManager.cancelSetup).toHaveBeenCalled()
  })

  // ─── P1 配对鉴权 ───────────────────────────────────────────────

  it('pairings: request → pending, approve → allowed', async () => {
    const { getWeixinPairingStore, resetWeixinPairingStoreForTests } = await import(
      '../../../src/server/services/weixinBot/WeixinPairingStore.js'
    )
    resetWeixinPairingStoreForTests()
    const store = getWeixinPairingStore()
    const req = await store.requestPairing('stranger_1')
    expect(req.code).toMatch(/^\d{6}$/)

    const app = makeApp()
    const listed = await request(app).get('/api/weixin/pairings')
    expect(listed.status).toBe(200)
    expect(listed.body.pending).toHaveLength(1)
    expect(listed.body.pending[0].senderId).toBe('stranger_1')

    const ok = await request(app).post('/api/weixin/pairings/approve').send({ senderId: 'stranger_1' })
    expect(ok.status).toBe(200)
    expect(ok.body.allowed.map((a: { senderId: string }) => a.senderId)).toContain('stranger_1')
    expect(ok.body.pending).toHaveLength(0)
    resetWeixinPairingStoreForTests()
  })

  it('pairings: reject removes pending', async () => {
    const { getWeixinPairingStore, resetWeixinPairingStoreForTests } = await import(
      '../../../src/server/services/weixinBot/WeixinPairingStore.js'
    )
    resetWeixinPairingStoreForTests()
    await getWeixinPairingStore().requestPairing('stranger_2')
    const app = makeApp()
    const res = await request(app).post('/api/weixin/pairings/reject').send({ senderId: 'stranger_2' })
    expect(res.status).toBe(200)
    expect(res.body.pending).toHaveLength(0)
    resetWeixinPairingStoreForTests()
  })

  it('pairings/approve without senderId → 400', async () => {
    const app = makeApp()
    const res = await request(app).post('/api/weixin/pairings/approve').send({})
    expect(res.status).toBe(400)
  })

  // ─── P5/P7 owner ──────────────────────────────────────────────

  it('GET /api/weixin/owner returns snapshot or null', async () => {
    mockManager.readOwner.mockResolvedValue({
      info: { instanceId: 'current', pid: 123, supervisorPid: 1, port: 9201, cwd: '/tmp', accountId: 'a', hostname: 'h', startedAt: 1 },
      live: true,
      self: false,
    })
    const app = makeApp()
    const res = await request(app).get('/api/weixin/owner')
    expect(res.status).toBe(200)
    expect(res.body.info.pid).toBe(123)
    expect(res.body.live).toBe(true)
  })

  it('POST /api/weixin/owner/takeover delegates to manager', async () => {
    const app = makeApp()
    const res = await request(app).post('/api/weixin/owner/takeover').send({})
    expect(res.status).toBe(200)
    expect(mockManager.forceTakeoverOwner).toHaveBeenCalled()
  })

  it('POST /api/weixin/owner/takeover → 409 when refused', async () => {
    mockManager.forceTakeoverOwner.mockResolvedValue({ ok: false, reason: 'owner pid=1 still alive' })
    const app = makeApp()
    const res = await request(app).post('/api/weixin/owner/takeover').send({})
    expect(res.status).toBe(409)
  })

  // ─── P4 观测 ──────────────────────────────────────────────────

  it('GET /api/weixin/diagnostics returns bindings + metrics', async () => {
    mockManager.listSessionBindings.mockResolvedValue([
      { conversationKey: 'acct:dm:u1', sessionId: 'sess-1', cwd: '/tmp', accountId: 'acct', chatType: 'dm', chatId: 'u1', senderId: 'u1', createdAt: 1, lastActiveAt: 2 },
    ])
    const app = makeApp()
    const res = await request(app).get('/api/weixin/diagnostics')
    expect(res.status).toBe(200)
    expect(res.body.supervisorManaged).toBe(true)
    expect(res.body.bindings).toHaveLength(1)
    expect(res.body.bindings[0].sessionId).toBe('sess-1')
  })
})
