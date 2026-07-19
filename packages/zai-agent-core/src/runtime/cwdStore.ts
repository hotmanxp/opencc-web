/**
 * Per-session cwd store.
 *
 * zai 是多 session 共享一个 server 实例,所以每个 session 需要自己的逻辑 cwd。
 * BashTool 在每条 sh -c 命令末尾注入 `pwd -P >| tmpfile` trailer,
 * 子进程退出后读 tmpfile 拿到新 cwd,通过 CwdStore.set 写进来。
 *
 * 仅内存,不持久化:进程崩溃 = session 重启 = transcript 重跑,cwd 自然归零。
 */

export interface SessionCwd {
  readonly cwd: string
  readonly updatedAt: number
}

const store = new Map<string, SessionCwd>()

export const CwdStore = {
  get(sessionId: string): string | undefined {
    return store.get(sessionId)?.cwd
  },

  set(sessionId: string, cwd: string): void {
    store.set(sessionId, { cwd, updatedAt: Date.now() })
  },

  getOrInit(sessionId: string, defaultCwd: string): string {
    const existing = store.get(sessionId)
    if (existing) return existing.cwd
    this.set(sessionId, defaultCwd)
    return defaultCwd
  },

  has(sessionId: string): boolean {
    return store.has(sessionId)
  },

  delete(sessionId: string): void {
    store.delete(sessionId)
  },

  size(): number {
    return store.size
  },

  clear(): void {
    store.clear()
  },
}
