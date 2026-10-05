import { ReplSession, type ReplHistoryService } from './ReplSession.js'

export interface ReplSessionOptions {
  historyService?: ReplHistoryService
}

export class ReplRegistry {
  private readonly map = new Map<string, ReplSession>()

  /**
   * 懒加载：sessionId 已有则返回旧实例；否则用 defaultCwd 新建。
   * 重复 get 不影响已有 instance 的 cwd — 已存在的 child 仍跑在原 cwd。
   * opts.historyService 仅在新建时生效,旧实例保留原 historyService。
   */
  get(
    sessionId: string,
    defaultCwd: string,
    opts: ReplSessionOptions = {},
  ): ReplSession {
    const existing = this.map.get(sessionId)
    if (existing) return existing
    const created = new ReplSession(defaultCwd, { historyService: opts.historyService })
    this.map.set(sessionId, created)
    return created
  }

  dispose(sessionId: string): void {
    const s = this.map.get(sessionId)
    if (s) {
      s.dispose()
      this.map.delete(sessionId)
    }
  }

  /**
   * 释放全部 session。进程退出路径(`runtimeLifecycle.closeServer`)调用 ——
   * 否则 `sh -c` 起的子进程会以孤儿身份被 init 收养并继续存活。
   *
   * 注意 PTY 路径不需要它:`node-pty` 走 forkpty,PTY shell 是 session leader
   * 且以 slave 为控制终端,master 关闭时内核自动发 SIGHUP 回收。这里回收的是
   * piped stdio 的普通子进程,父进程干净 `process.exit(0)` 时收不到任何信号。
   */
  disposeAll(): void {
    for (const s of this.map.values()) {
      try {
        s.dispose()
      } catch {
        /* 单个 session 释放失败不阻断其余回收 */
      }
    }
    this.map.clear()
  }

  /** 测试用 */
  size(): number {
    return this.map.size
  }
}

let _singleton: ReplRegistry | null = null

export function getReplRegistry(): ReplRegistry {
  if (!_singleton) _singleton = new ReplRegistry()
  return _singleton
}

/** 测试 seam：清空单例 + 释放所有 session。 */
export function __resetReplRegistryForTest(): void {
  if (_singleton) {
    // 通过 cast 访问私有字段（strict TS 不允许 `private` 外部直接访问）。
    const sessions = Array.from((_singleton as unknown as { map: Map<string, unknown> }).map.values()) as Array<{ dispose: () => void }>
    for (const s of sessions) s.dispose()
  }
  _singleton = null
}