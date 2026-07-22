// packages/zai/src/server/services/approveRegistry.ts
// In-memory registry of pending RequestApprove decisions. Mirrors
// askRegistry.ts shape exactly so the runtime contract is symmetric.
//
// One Promise<{decision, comment?}> per toolUseId. The HTTP route
// /api/agent/approve resolves it; the runtime's bridged
// `ctx.awaitApprove` registers it; abortAll is called on session
// disconnect.
//
// filePath lives alongside the registry entry so /api/agent/approve/file
// can resolve the same target the front end saw in the SSE event (the
// SSE payload is just the path — no body bytes hit the wire).

type PendingDecision = 'approved' | 'rejected'

type Pending = {
  resolve: (d: { decision: PendingDecision; comment?: string }) => void
  reject: (e: Error) => void
  toolUseId: string
  sessionId: string
  filePath: string
}

export class ApproveRegistry {
  private pending = new Map<string, Pending>()

  register(
    toolUseId: string,
    sessionId: string,
    filePath: string,
    abortSignal: AbortSignal,
  ): Promise<{ decision: PendingDecision; comment?: string }> {
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
        filePath,
      })
    })
  }

  // Read-only peek. Used by the HTTP route for sid-mismatch defense
  // (before calling answer / reject).
  peek(toolUseId: string): Pending | undefined {
    return this.pending.get(toolUseId)
  }

  // Read the resolved filePath so /api/agent/approve/file can serve it.
  // Mirrors peek() for sid-mismatch defense: undefined if no pending entry.
  getFilePath(toolUseId: string): string | undefined {
    return this.pending.get(toolUseId)?.filePath
  }

  answer(
    toolUseId: string,
    payload: { decision: PendingDecision; comment?: string },
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

  // For diagnostics / future session-replay; not used in v1 hot path.
  listBySession(sessionId: string): Pending[] {
    const out: Pending[] = []
    for (const p of this.pending.values()) {
      if (p.sessionId === sessionId) out.push(p)
    }
    return out
  }
}
