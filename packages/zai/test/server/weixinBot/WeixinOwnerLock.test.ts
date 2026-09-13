/**
 * WeixinOwnerLock 测试 —— P5 机器级全局单实例锁。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WeixinOwnerLock,
  buildSelfOwnerInfo,
} from '../../../src/server/services/weixinBot/WeixinOwnerLock.js'
import { weixinOwnerFile } from '../../../src/server/services/paths.js'

const info = (over: Partial<ReturnType<typeof buildSelfOwnerInfo>> = {}) => ({
  instanceId: 'current',
  pid: process.pid,
  supervisorPid: 1,
  port: 9201,
  cwd: '/proj',
  accountId: 'acct',
  hostname: 'test-host',
  startedAt: Date.now(),
  ...over,
})

describe('WeixinOwnerLock', () => {
  beforeEach(() => {
    process.env.ZAI_WEIXIN_OWNER_LOCK_DIR = mkdtempSync(join(tmpdir(), 'zai-wx-owner-'))
  })

  it('首次 acquire 成功,read 显示 live + self', async () => {
    const res = await WeixinOwnerLock.acquire(info())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const snap = await WeixinOwnerLock.read()
    expect(snap).not.toBeNull()
    expect(snap!.live).toBe(true)
    expect(snap!.self).toBe(true)
    expect(snap!.info.pid).toBe(process.pid)
    await res.handle.release()
  })

  it('第二个持有者被拒,并拿到 heldBy 元数据(全局单实例核心断言)', async () => {
    const first = await WeixinOwnerLock.acquire(info({ instanceId: 'inst_A' }))
    expect(first.ok).toBe(true)
    const second = await WeixinOwnerLock.acquire(info({ instanceId: 'inst_B' }))
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.heldBy?.instanceId).toBe('inst_A')
    expect(second.heldBy?.pid).toBe(process.pid)
    if (first.ok) await first.handle.release()
  })

  it('release 后他人可获取', async () => {
    const first = await WeixinOwnerLock.acquire(info())
    if (first.ok) await first.handle.release()
    const second = await WeixinOwnerLock.acquire(info({ instanceId: 'inst_C' }))
    expect(second.ok).toBe(true)
    if (second.ok) await second.handle.release()
  })

  it('release 会清掉 owner.json(read 返回 null)', async () => {
    const res = await WeixinOwnerLock.acquire(info())
    if (res.ok) await res.handle.release()
    expect(await WeixinOwnerLock.read()).toBeNull()
  })

  it('update() 刷新元数据(QR 确认后 accountId 落定)', async () => {
    const res = await WeixinOwnerLock.acquire(info({ accountId: 'pending' }))
    if (!res.ok) throw new Error('acquire failed')
    await res.handle.update({ accountId: 'real_acct' })
    const snap = await WeixinOwnerLock.read()
    expect(snap!.info.accountId).toBe('real_acct')
    await res.handle.release()
  })

  it('残留的失联持有者(owner.json 存在但无锁)→ read live=false,可 forceTakeover', async () => {
    await writeFile(
      weixinOwnerFile(),
      JSON.stringify(info({ pid: 999_999, instanceId: 'dead' })),
      { mode: 0o600 },
    )
    const snap = await WeixinOwnerLock.read()
    expect(snap).not.toBeNull()
    expect(snap!.live).toBe(false)

    const takeover = await WeixinOwnerLock.forceTakeover()
    expect(takeover.ok).toBe(true)
    expect(await WeixinOwnerLock.read()).toBeNull()
  })

  it('buildSelfOwnerInfo 记录 supervisorPid / ZAI_INSTANCE_ID', () => {
    const prevSup = process.env.ZAI_SUPERVISOR_PID
    const prevInst = process.env.ZAI_INSTANCE_ID
    process.env.ZAI_SUPERVISOR_PID = '4242'
    process.env.ZAI_INSTANCE_ID = 'inst_Z'
    try {
      const built = buildSelfOwnerInfo({ cwd: '/p', accountId: 'a' })
      expect(built.supervisorPid).toBe(4242)
      expect(built.instanceId).toBe('inst_Z')
      expect(built.pid).toBe(process.pid)
    } finally {
      if (prevSup === undefined) delete process.env.ZAI_SUPERVISOR_PID
      else process.env.ZAI_SUPERVISOR_PID = prevSup
      if (prevInst === undefined) delete process.env.ZAI_INSTANCE_ID
      else process.env.ZAI_INSTANCE_ID = prevInst
    }
  })
})
