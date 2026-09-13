/**
 * WeixinPairingStore 测试 —— P1 配对鉴权(准入 / 码 TTL / 尝试上限 / 限次)。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WeixinPairingStore,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_REQUESTS_PER_HOUR,
  PAIRING_MAX_VERIFY_ATTEMPTS,
} from '../../../src/server/services/weixinBot/WeixinPairingStore.js'

describe('WeixinPairingStore', () => {
  let store: WeixinPairingStore
  const created: WeixinPairingStore[] = []
  const make = () => {
    const s = new WeixinPairingStore()
    created.push(s)
    return s
  }
  beforeEach(() => {
    process.env.ZAI_DATA_DIR = mkdtempSync(join(tmpdir(), 'zai-wx-pairing-'))
    store = make()
  })
  afterEach(async () => {
    vi.useRealTimers()
    // flush fire-and-forget 落盘,避免写到下一个用例的数据目录
    await Promise.all(created.splice(0).map((s) => s.flush()))
  })

  it('未批准用户默认不在白名单', async () => {
    expect(await store.isAllowed('stranger')).toBe(false)
    expect(store.allowedSenderIds()).toEqual([])
  })

  it('requestPairing 生成 6 位码,进入 pending', async () => {
    const r = await store.requestPairing('stranger', '陌生人')
    expect(r.code).toMatch(/^\d{6}$/)
    expect(r.rateLimited).toBeFalsy()
    const list = await store.list()
    expect(list.pending).toHaveLength(1)
    expect(list.pending[0].senderId).toBe('stranger')
    expect(list.pending[0].displayName).toBe('陌生人')
    expect(await store.isAllowed('stranger')).toBe(false)
  })

  it('码未过期时重复申领复用同一码(不刷屏)', async () => {
    const a = await store.requestPairing('stranger')
    const b = await store.requestPairing('stranger')
    expect(b.code).toBe(a.code)
    expect(b.reused).toBe(true)
  })

  it('Web 面板批准 → 进入白名单 + 清空 pending', async () => {
    await store.requestPairing('stranger')
    await store.approve('stranger', 'web')
    expect(await store.isAllowed('stranger')).toBe(true)
    expect(store.allowedSenderIds()).toContain('stranger')
    const list = await store.list()
    expect(list.pending).toHaveLength(0)
    expect(list.allowed[0].approvedVia).toBe('web')
  })

  it('reject 移除 pending 但不放行', async () => {
    await store.requestPairing('stranger')
    expect(await store.reject('stranger')).toBe(true)
    expect(await store.isAllowed('stranger')).toBe(false)
    expect((await store.list()).pending).toHaveLength(0)
  })

  it('revoke 吊销已批准用户', async () => {
    await store.requestPairing('stranger')
    await store.approve('stranger')
    expect(await store.revoke('stranger')).toBe(true)
    expect(await store.isAllowed('stranger')).toBe(false)
  })

  it('码过期后 pending 被清理,verifyCode 返回 expired', async () => {
    const t0 = Date.now()
    const r = await store.requestPairing('stranger', undefined, t0)
    const res = await store.verifyCode('stranger', r.code, t0 + PAIRING_CODE_TTL_MS + 1)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('expired')
    expect((await store.list()).pending).toHaveLength(0)
  })

  it('回码错误累计 attempts,超限后码作废(防暴力枚举)', async () => {
    const t0 = Date.now()
    await store.requestPairing('stranger', undefined, t0)
    for (let i = 0; i < PAIRING_MAX_VERIFY_ATTEMPTS; i++) {
      const res = await store.verifyCode('stranger', '000000', t0)
      expect(res.ok).toBe(false)
    }
    // 已作废,即使回对码也无效
    const after = await store.verifyCode('stranger', '000000', t0)
    expect(after.reason).toBe('no-pending')
  })

  it('回码正确 → 直接批准(approvedVia=code)', async () => {
    const t0 = Date.now()
    const r = await store.requestPairing('stranger', undefined, t0)
    const res = await store.verifyCode('stranger', r.code, t0)
    expect(res.ok).toBe(true)
    expect(await store.isAllowed('stranger')).toBe(true)
    expect((await store.list()).allowed[0].approvedVia).toBe('code')
  })

  it('1 小时内申领次数超限 → rateLimited', async () => {
    const t0 = Date.now()
    // 每次让上次的码过期,才能再次申领
    for (let i = 0; i < PAIRING_MAX_REQUESTS_PER_HOUR; i++) {
      const now = t0 + i * (PAIRING_CODE_TTL_MS + 1)
      const r = await store.requestPairing('stranger', undefined, now)
      expect(r.rateLimited).toBeFalsy()
    }
    // 第 3 次申领的码过期时间(TTL 之后)仍在 1 小时窗口内 → 触发限次
    const overflow = await store.requestPairing(
      'stranger',
      undefined,
      t0 + 2 * (PAIRING_CODE_TTL_MS + 1) + PAIRING_CODE_TTL_MS + 1,
    )
    expect(overflow.rateLimited).toBe(true)
    expect(overflow.code).toBe('')
  })

  it('持久化:新实例能恢复白名单', async () => {
    await store.requestPairing('stranger')
    await store.approve('stranger')
    const fresh = make()
    expect(await fresh.isAllowed('stranger')).toBe(true)
  })
})
