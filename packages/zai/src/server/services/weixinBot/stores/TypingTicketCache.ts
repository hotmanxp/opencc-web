/**
 * iLink typing_ticket 内存缓存(per user, TTL 600s)。
 *
 * iLink getConfig 返回的 typing_ticket 用于 sendtyping,10 分钟有效。
 * 缓存避免每次 send_typing 都打 getConfig。
 *
 * 过期清理:按需惰性清理 + 构造时挂定时器兜底。
 */
export interface TypingTicketCacheOptions {
  ttlSeconds?: number
  /** 兜底清理间隔,默认 60s */
  sweepIntervalMs?: number
}

export class TypingTicketCache {
  private readonly ttlMs: number
  private readonly map = new Map<string, { ticket: string; expiresAt: number }>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: TypingTicketCacheOptions = {}) {
    this.ttlMs = (opts.ttlSeconds ?? 600) * 1000
    const interval = opts.sweepIntervalMs ?? 60_000
    this.sweepTimer = setInterval(() => this.sweep(), interval)
    // 不阻止进程退出
    this.sweepTimer.unref?.()
  }

  get(userId: string): string | null {
    const entry = this.map.get(userId)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(userId)
      return null
    }
    return entry.ticket
  }

  set(userId: string, ticket: string): void {
    this.map.set(userId, { ticket, expiresAt: Date.now() + this.ttlMs })
  }

  delete(userId: string): void {
    this.map.delete(userId)
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
      if (v.expiresAt <= now) this.map.delete(k)
    }
  }

  /** 测试用 */
  size(): number {
    return this.map.size
  }
}
