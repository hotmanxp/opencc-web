// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P2): elicitation web UI bridge.
 * Replaces vendor ElicitationDialog (React/Ink UI) with zai web UI.
 * Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §2.3.
 *
 * Pattern matches PermissionRegistry / AskRegistry.
 */

import { randomUUID } from 'crypto'

export type ElicitRequestInput = {
  elicitationId?: string
  mcpServerName: string
  message: string
  mode: 'form' | 'url'
  url?: string
  requestedSchema?: Record<string, unknown>
}

export type ElicitResult = {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

type Pending = {
  resolve: (result: ElicitResult) => void
  reject: (err: Error) => void
}

export class ElicitationRegistry {
  private pending = new Map<string, Pending>()

  async request(input: ElicitRequestInput): Promise<ElicitResult> {
    const id = input.elicitationId ?? randomUUID()
    return new Promise<ElicitResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // TODO(P2): emit SSE event 'elicitation.request' for frontend reducer.
      // For P2 testability, the test invokes resolve() directly.
    })
  }

  resolve(id: string, result: ElicitResult): void {
    const p = this.pending.get(id)
    if (!p) return // orphan
    this.pending.delete(id)
    p.resolve(result)
  }

  cancel(id: string): void {
    this.resolve(id, { action: 'cancel' })
  }

  hasPending(): boolean {
    return this.pending.size > 0
  }
}