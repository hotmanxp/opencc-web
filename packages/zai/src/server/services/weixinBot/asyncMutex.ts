/**
 * Async mutex — 简单的 N-1 串行化原语,出站 send 互锁避免 iLink 限流重击。
 */
export class AsyncMutex {
  private locked = false
  private waiters: Array<() => void> = []

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
    } else {
      this.locked = false
    }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}
