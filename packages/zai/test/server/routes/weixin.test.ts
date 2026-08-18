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
  return {
    status: vi.fn(() => ({
      configured: false,
      enabled: false,
      state: 'unconfigured',
    })),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    saveAccount: vi.fn(async () => undefined),
    getAdapter: vi.fn(() => null),
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
  beforeEach(() => {
    mockManager = makeMockManager()
  })

  it('GET /api/weixin/status returns 200 with status', async () => {
    const app = makeApp()
    const res = await request(app).get('/api/weixin/status')
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('unconfigured')
    expect(mockManager.status).toHaveBeenCalled()
  })

  it('POST /api/weixin/connect calls manager.start', async () => {
    const app = makeApp()
    const res = await request(app).post('/api/weixin/connect').send({})
    expect(res.status).toBe(200)
    expect(mockManager.start).toHaveBeenCalled()
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
})
