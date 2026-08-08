// packages/zai/src/server/services/permissionRegistry.ts
// In-memory registry of pending `behavior:'ask'` permission decisions.
// Mirrors askRegistry.ts shape exactly so the runtime contract is symmetric.
//
// One Promise<{decision, message?}> per toolUseId. The HTTP route
// /api/agent/permission-response resolves it; the headless permission bridge
// (opencc-src/server/headlessPermissionBridge.ts) registers it when vendor's
// canUseTool returns `ask`; abortAll is called on session disconnect.
//
// The answer payload deliberately mirrors the AskUserQuestion flow:
// `{ decision: 'allow' | 'deny', message? }` — allow lets the tool run
// (optionally with updatedInput), deny surfaces a rejection to the model.

type PermissionDecision = 'allow' | 'deny'

type Pending = {
  resolve: (d: { decision: PermissionDecision; message?: string; updatedInput?: Record<string, unknown> }) => void
  reject: (e: Error) => void
  toolUseId: string
  sessionId: string
  /**
   * 持有当前 entry 注册到 abortSignal 上的 listener 引用,使后续
   * 同 toolUseId 的 register() 在覆盖 pending 前能把它从 signal 摘掉,
   * 避免旧 listener 变成孤儿挂在 signal 上(直到 signal 真的 abort 才被
   * { once: true } 自动清掉 — fire-and-forget 请求路径下 signal 经常
   * 不 abort,孤儿堆积到 50+ 触发 MaxListenersExceededWarning)。
   */
  onAbort: () => void
}

export class PermissionRegistry {
  private pending = new Map<string, Pending>()

  register(
    toolUseId: string,
    sessionId: string,
    abortSignal: AbortSignal,
  ): Promise<{ decision: PermissionDecision; message?: string; updatedInput?: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      // 幂等保护:同 toolUseId 二次 register 时,先把旧 listener 从 signal
      // 上摘掉再覆盖 pending。否则旧 entry 的包装 resolve/reject 不可达,
      // onAbort 永远清不掉,直到 signal 真的 abort 才被 { once: true } 兜底。
      const existing = this.pending.get(toolUseId)
      if (existing) {
        abortSignal.removeEventListener('abort', existing.onAbort)
      }
      const onAbort = () => {
        if (this.pending.delete(toolUseId)) {
          reject(new Error('aborted'))
        }
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(toolUseId, {
        resolve: (d) => {
          abortSignal.removeEventListener('abort', onAbort)
          resolve(d)
        },
        reject: (e) => {
          abortSignal.removeEventListener('abort', onAbort)
          reject(e)
        },
        toolUseId,
        sessionId,
        onAbort,
      })
    })
  }

  // Read-only peek. Used by the HTTP route for sid-mismatch defense
  // (before calling answer / reject).
  peek(toolUseId: string): Pending | undefined {
    return this.pending.get(toolUseId)
  }

  answer(
    toolUseId: string,
    payload: { decision: PermissionDecision; message?: string; updatedInput?: Record<string, unknown> },
  ): boolean {
    const p = this.pending.get(toolUseId)
    if (!p) return false
    this.pending.delete(toolUseId)
    p.resolve(payload)
    return true
  }

  reject(toolUseId: string, reason = 'user_rejected'): boolean {
    const p = this.pending.get(toolUseId)
    if (!p) return false
    this.pending.delete(toolUseId)
    p.reject(new Error(reason))
    return true
  }

  abortAll(reason = 'session_aborted'): void {
    for (const p of this.pending.values()) {
      this.pending.delete(p.toolUseId)
      p.reject(new Error(reason))
    }
  }
}
