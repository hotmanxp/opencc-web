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
}

export class PermissionRegistry {
  private pending = new Map<string, Pending>()

  register(
    toolUseId: string,
    sessionId: string,
    abortSignal: AbortSignal,
  ): Promise<{ decision: PermissionDecision; message?: string; updatedInput?: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
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
