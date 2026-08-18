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
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { WEIXIN_LOCKS_DIR } from './paths-internal.js'
import { ACCOUNT_LOCK_MAX_TIMEOUT_MS, ACCOUNT_LOCK_MIN_TIMEOUT_MS, ACCOUNT_LOCK_RETRIES } from './constants.js'

export class AccountLock {
  private released = false

  /**
   * 获取 token 的账号锁。失败抛 LockAcquireError,信息含 token 摘要(8 字符)
   * 与目录,方便多实例调试。
   */
  static async acquire(token: string): Promise<AccountLock> {
    await mkdir(WEIXIN_LOCKS_DIR, { recursive: true })
    const safe = AccountLock.tokenHash(token)
    const lockPath = join(WEIXIN_LOCKS_DIR, `${safe}.lock`)
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
}
