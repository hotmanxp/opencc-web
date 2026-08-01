/**
 * Per-session cwd store.
 *
 * zai 是多 session 共享一个 server 实例,所以每个 session 需要自己的逻辑 cwd。
 * BashTool 在每条 sh -c 命令末尾注入 `pwd -P >| tmpfile` trailer,
 * 子进程退出后读 tmpfile 拿到新 cwd,通过 CwdStore.set 写进来。
 *
 * 仅内存,不持久化:进程崩溃 = session 重启 = transcript 重跑,cwd 自然归零。
 *
 * The `claude-<taskId>-cwd` trailer path (opencc's actual filename) lives in
 * `readTrailer` for any consumer that wants to read it directly; the regular
 * `get`/`set` API matches what callers expect.
 */

export interface SessionCwd {
  readonly cwd: string
  readonly updatedAt: number
}

const store = new Map<string, SessionCwd>()

class CwdStoreImpl {
  get(sessionId: string): string | undefined {
    return store.get(sessionId)?.cwd
  }

  set(sessionId: string, cwd: string): void {
    store.set(sessionId, { cwd, updatedAt: Date.now() })
  }

  getOrInit(sessionId: string, defaultCwd: string): string {
    const existing = store.get(sessionId)
    if (existing) return existing.cwd
    this.set(sessionId, defaultCwd)
    return defaultCwd
  }

  has(sessionId: string): boolean {
    return store.has(sessionId)
  }

  delete(sessionId: string): void {
    store.delete(sessionId)
  }

  size(): number {
    return store.size
  }

  clear(): void {
    store.clear()
  }

  /**
   * Read the cwd trailer file produced by opencc's BashProvider.
   * OpenCC writes `<tmpdir>/claude-<taskId>-cwd` after each sh -c
   * (see `opencc-src/utils/shell/bashProvider.ts` — `nativeJoin(tmpdir, 'claude-${opts.id}-cwd')`).
   * The `claude-` prefix is the upstream Claude Code convention carried over.
   * This is a convenience read for any consumer that wants the freshest value
   * straight off disk; the regular `get` API returns whatever's already in
   * the in-memory map.
   */
  readTrailer(taskId: string): string | undefined {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const { join } = require('node:path') as typeof import('node:path')
    try {
      return readFileSync(join(tmpdir(), `claude-${taskId}-cwd`), 'utf-8').trim()
    } catch {
      return undefined
    }
  }
}

export const CwdStore = new CwdStoreImpl()