/**
 * AccountLock base 文件泄漏(M5 / `weixin-media-unbounded--by-zai`)。
 *
 * acquire 每次都 `writeFile` 出一个 `<hash>.lock` base 文件(proper-lockfile
 * 要求目标存在),而 release() 只回收 proper-lockfile 建的 `<hash>.lock.lock`
 * **目录**,从不删 base 文件 —— locks/ 因此单调增长。实测某机器 1740 个 0 字节
 * 文件、整目录 du = 0B。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'zai-weixin-locks-'))
process.env.ZAI_DATA_DIR = dataDir

const { AccountLock } = await import('../../../src/server/services/weixinBot/AccountLock.js')
const { weixinLocksDir } = await import('../../../src/server/services/weixinBot/paths-internal.js')

const locksDir = () => weixinLocksDir()

describe('AccountLock — base 文件回收', () => {
  beforeEach(() => {
    rmSync(locksDir(), { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('同一 token 反复 acquire/release 100 次,目录项数不增长', async () => {
    for (let i = 0; i < 100; i++) {
      const lock = await AccountLock.acquire('tok-same')
      await lock.release()
    }
    // base 文件按设计保留 1 个(下次 acquire 复用),不能是 100 个
    const entries = readdirSync(locksDir())
    expect(entries.filter((e) => e.endsWith('.lock'))).toHaveLength(1)
    // 锁目录必须被 release 回收干净
    expect(entries.filter((e) => e.endsWith('.lock.lock'))).toHaveLength(0)
  })

  it('不同 token 各留一个 base 文件,不会互相误删', async () => {
    for (const t of ['tok-a', 'tok-b', 'tok-c']) {
      const lock = await AccountLock.acquire(t)
      await lock.release()
    }
    expect(readdirSync(locksDir()).filter((e) => e.endsWith('.lock'))).toHaveLength(3)
  })

  it('清扫会删掉超过 24h 且未被持有的 base 文件', async () => {
    const lock = await AccountLock.acquire('tok-old')
    await lock.release()

    // 把 base 文件的 mtime 拨到 25 天前,模拟历史遗留
    const base = readdirSync(locksDir()).find((e) => e.endsWith('.lock'))!
    const basePath = join(locksDir(), base)
    const old = new Date(Date.now() - 25 * 24 * 60 * 60_000)
    utimesSync(basePath, old, old)
    expect(statSync(basePath).mtimeMs).toBeLessThan(Date.now() - 24 * 60 * 60_000)

    // 下一次 acquire 触发清扫
    const lock2 = await AccountLock.acquire('tok-new')
    await lock2.release()

    const remaining = readdirSync(locksDir()).filter((e) => e.endsWith('.lock'))
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).not.toBe(base)
  })

  it('清扫不会删掉仍被持有的锁的 base 文件', async () => {
    const held = await AccountLock.acquire('tok-held')

    // 把 base 文件 mtime 拨老,模拟长期持有的锁
    const base = readdirSync(locksDir()).find((e) => e.endsWith('.lock'))!
    const old = new Date(Date.now() - 25 * 24 * 60 * 60_000)
    utimesSync(join(locksDir(), base), old, old)

    // 另一个 token 的 acquire 会触发清扫 —— 但持有中的锁必须毫发无损
    const other = await AccountLock.acquire('tok-other')
    await other.release()

    expect(readdirSync(locksDir())).toContain(base)

    // 关键断言:锁仍然有效 —— 重复 acquire 同一 token 必须拿不到
    let reacquired = false
    try {
      await AccountLock.acquire('tok-held')
      reacquired = true
    } catch {
      // 预期:拿不到锁
    }
    expect(reacquired).toBe(false)

    await held.release()
  })
})
