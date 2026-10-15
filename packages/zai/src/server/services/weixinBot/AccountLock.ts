/**
 * 微信账号 token 单实例锁(proper-lockfile)。
 *
 * 同一 iLink token 只能被一个 zai 实例拉,否则双 poller 互相抢消息导致
 * 服务端报错 / 频率限制。锁文件放在 ~/.zai/weixin/locks/<sha256(token).hex>.lock
 * 目录,token 不入路径(防止锁文件目录被 `ls` 时泄漏)。
 *
 * 跨平台:proper-lockfile 在 Linux/macOS 用 fcntl,Windows 用 Lockfile,无需特别
 * 配置;stale 锁会自动清理。
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { weixinLocksDir } from './paths-internal.js'
import { ACCOUNT_LOCK_MAX_TIMEOUT_MS, ACCOUNT_LOCK_MIN_TIMEOUT_MS, ACCOUNT_LOCK_RETRIES } from './constants.js'

/** 超过这个年龄且未持锁的 base 文件才清 —— 给「另一个进程刚 acquire、
 *  还没来得及 mkdir 锁目录」的窗口留足余量。 */
const STALE_BASE_FILE_MS = 24 * 60 * 60_000

export class AccountLock {
  private released = false

  /**
   * 获取 token 的账号锁。失败抛 LockAcquireError,信息含 token 摘要(8 字符)
   * 与目录,方便多实例调试。
   */
  static async acquire(token: string): Promise<AccountLock> {
    await mkdir(weixinLocksDir(), { recursive: true })
    // 清历史遗留:acquire 每次都无条件 touch 出一个 base 文件,而 release()
    // 只回收 proper-lockfile 建的 `.lock` **目录**、从不删 base 文件,于是
    // locks/ 单调增长(实测某机器 1740 个 0 字节文件)。每次 acquire 顺带清扫。
    await AccountLock.sweepStaleBaseFiles()
    const safe = AccountLock.tokenHash(token)
    const lockPath = join(weixinLocksDir(), `${safe}.lock`)
    // proper-lockfile 要求锁文件存在;先 touch
    if (!existsSync(lockPath)) {
      await writeFile(lockPath, '', { mode: 0o600 })
    }
    let releaseFn: (() => Promise<void>) | null = null
    try {
      releaseFn = await lockfile.lock(lockPath, {
        retries: { retries: ACCOUNT_LOCK_RETRIES, minTimeout: ACCOUNT_LOCK_MIN_TIMEOUT_MS, maxTimeout: ACCOUNT_LOCK_MAX_TIMEOUT_MS },
      })
    } catch (err) {
      throw new Error(
        `weixin-bot: failed to acquire account lock for token ${safe.slice(0, 8)}: ${(err as Error).message}`,
      )
    }
    const inst = new AccountLock(releaseFn!, lockPath, safe)
    return inst
  }

  private constructor(
    private readonly releaseFn: () => Promise<void>,
    private readonly lockPath: string,
    private readonly tokenHashHex: string,
  ) {}

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    try {
      await this.releaseFn()
    } catch {
      // 释放失败不抛 — 锁会被 stale 清理
    }
  }

  /** 调试用 */
  path(): string {
    return this.lockPath
  }

  static tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  /**
   * 清掉不再被任何锁持有的 base 文件。
   *
   * 布局:base 文件 `<hash>.lock` + proper-lockfile 建的锁目录 `<hash>.lock.lock`。
   * release() 只删后者。判定「未持有」看**锁目录是否存在** —— 目录在,说明有人
   * 正持有(或 stale 未清),一律跳过;这不依赖 proper-lockfile 的 mtime 判定,
   * 也不受它 `stale` 选项影响,所以删 base 文件不会破坏任何在用的锁。
   *
   * 年龄门槛再兜一层:刚 acquire 的进程可能还没 mkdir 出锁目录,那段时间它的
   * base 文件看起来也是「未被持有」的。24h 远大于该窗口。
   */
  private static async sweepStaleBaseFiles(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(weixinLocksDir())
    } catch {
      return // 目录还不存在
    }
    const now = Date.now()
    for (const name of entries) {
      // 锁目录是 base + '.lock';base 自身以 '.lock' 结尾
      if (!name.endsWith('.lock')) continue
      const basePath = join(weixinLocksDir(), name)
      // 有人持有(含 stale 未清)→ 不碰
      if (existsSync(`${basePath}.lock`)) continue
      try {
        const st = await stat(basePath)
        if (!st.isFile()) continue
        if (now - st.mtimeMs < STALE_BASE_FILE_MS) continue
        await unlink(basePath)
      } catch {
        /* 并发下可能已被删,忽略 */
      }
    }
  }
}
