/**
 * 入站消息去重缓存(TTL 5 分钟)。
 *
 * 两类指纹(key):
 *   - message_id:iLink 给每条消息分配唯一 ID,正常情况下唯一。
 *   - content:<sender>:<md5(text)>:内容指纹,捕捉 iLink 偶发重复 + 文本 debounce
 *     合并前的同文本多次入站。
 *
 * 命中即续期(返回 true 并刷新 expiresAt),避免短时间内反复击中。
 */
export interface MessageDeduplicatorOptions {
  ttlSeconds?: number
  /** 兜底清理间隔,默认 30s */
  sweepIntervalMs?: number
}

export class MessageDeduplicator {
  private readonly ttlMs: number
  private readonly map = new Map<string, number>() // key → expiresAt(ms)
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: MessageDeduplicatorOptions = {}) {
    this.ttlMs = (opts.ttlSeconds ?? 300) * 1000
    const interval = opts.sweepIntervalMs ?? 30_000
    this.sweepTimer = setInterval(() => this.sweep(), interval)
    this.sweepTimer.unref?.()
  }

  /**
   * 命中检测 + 续期。返回 true 表示这是重复消息,调用方应 skip。
   * 返回 false 表示首次见到,内部已记录。
   */
  isDuplicate(key: string): boolean {
    const now = Date.now()
    const expiresAt = this.map.get(key)
    if (expiresAt !== undefined && expiresAt > now) {
      this.map.set(key, now + this.ttlMs) // 续期
      return true
    }
    this.map.set(key, now + this.ttlMs)
    return false
  }

  clear(): void {
    this.map.clear()
  }

  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.map.clear()
  }

  private sweep(): void {
    const now = Date.now()
    for (const [k, v] of this.map) {
      if (v <= now) this.map.delete(k)
    }
  }

  size(): number {
    return this.map.size
  }
}
