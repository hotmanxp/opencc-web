/**
 * zai patch (2026-08-30, plan P2): elicitation web UI bridge.
 * Replaces vendor ElicitationDialog (React/Ink UI) with zai web UI.
 * Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §2.3.
 *
 * Pattern matches PermissionRegistry / AskRegistry.
 *
 * P3 prerequisite (NOT YET IMPLEMENTED): abortAll() / abort-signal path.
 * When this registry adopts abortSignal wiring (mirror permissionRegistry.register),
 * add an abortAll(reason) method and per-entry onAbort listener tracking so that
 * session disconnect can cancel in-flight elicitations. Tracking here so the
 * P3 plan does not miss it.
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
  /**
   * 当 caller 未提供 elicitationId 时,registry 在 request() 内部生成一个
   * 并通过 result 回填,使 caller 仍能获知 id 用于后续 cancel / 关联 SSE。
   * caller 显式传入 id 时本字段缺失(回传冗余)。
   */
  elicitationId?: string
}

type Pending = {
  resolve: (result: ElicitResult) => void
}

export class ElicitationRegistry {
  private pending = new Map<string, Pending>()

  request(input: ElicitRequestInput): Promise<ElicitResult> {
    const callerProvided = input.elicitationId !== undefined
    const id = input.elicitationId ?? randomUUID()
    if (this.pending.has(id)) {
      // 幂等保护:同 elicitationId 二次 request 直接抛错,避免静默覆盖导致
      // 第一次的 promise 永远孤儿化。与 PermissionRegistry.register 的
      // listener 摘除不同(那里有 abortSignal 可摘),此处没有外部 listener,
      // 旧 entry 的 resolve/reject 不可达,所以选择直接拒绝。
      throw new Error(`elicitationId ${id} already pending`)
    }
    return new Promise<ElicitResult>((resolve) => {
      // 把 pending 登记成"会注入 elicitationId"的版本 — 只在 caller 没自带
      // id 的路径上需要回填。caller 自带 id 时 resolve 路径直接传 result,
      // 不污染已有 id 的契约。
      const pendingResolve: (result: ElicitResult) => void = callerProvided
        ? resolve
        : (result) => resolve({ ...result, elicitationId: id })
      this.pending.set(id, { resolve: pendingResolve })
      // TODO(P3): emit SSE event 'elicitation.request' for frontend reducer.
      // P3 is the next plan phase — for P2 testability, the test invokes
      // resolve() directly.
    })
  }

  resolve(id: string, result: ElicitResult): boolean {
    const p = this.pending.get(id)
    if (!p) return false // orphan
    this.pending.delete(id)
    p.resolve(result)
    return true
  }

  cancel(id: string): boolean {
    return this.resolve(id, { action: 'cancel' })
  }

  hasPending(): boolean {
    return this.pending.size > 0
  }
}
