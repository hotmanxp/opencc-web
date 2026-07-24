import { ReplSession } from './ReplSession.js'

export class ReplRegistry {
  private readonly map = new Map<string, ReplSession>()

  /**
   * 懒加载：sessionId 已有则返回旧实例；否则用 defaultCwd 新建。
   * 重复 get 不影响已有 instance 的 cwd — 已存在的 child 仍跑在原 cwd。
   */
  get(sessionId: string, defaultCwd: string): ReplSession {
    const existing = this.map.get(sessionId)
    if (existing) return existing
    const created = new ReplSession(defaultCwd)
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
}

let _singleton: ReplRegistry | null = null

export function getReplRegistry(): ReplRegistry {
  if (!_singleton) _singleton = new ReplRegistry()
  return _singleton
}

/** 测试 seam：清空单例 + 释放所有 session。 */
export function __resetReplRegistryForTest(): void {
  if (_singleton) {
    for (const s of _singleton.map.values()) s.dispose()
  }
  _singleton = null
}