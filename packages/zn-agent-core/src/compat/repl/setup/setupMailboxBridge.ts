// packages/zn-agent-core/src/compat/repl/setup/setupMailboxBridge.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P1): L1 hook adapter — setupMailboxBridge.
 * Writes cross-session messages to recipient's inbox file. Mirrors
 * useMailboxBridge semantics.
 */

import { appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

type SetupMailboxBridgeOpts = {
  sessionId: string
  cwd: string
  teamName?: string
  agentName?: string
  onSubmitMessage: (msg: any) => void
}

export function setupMailboxBridge(opts: SetupMailboxBridgeOpts) {
  let disposed = false

  return {
    async send(to: string, msg: any) {
      if (disposed) return
      const inboxDir = join(opts.cwd, '.zai', 'inbox')
      mkdirSync(inboxDir, { recursive: true })
      const filePath = join(inboxDir, `${to}.jsonl`)
      const entry = {
        from: opts.sessionId,
        team: opts.teamName,
        agent: opts.agentName,
        timestamp: Date.now(),
        payload: msg,
      }
      try {
        appendFileSync(filePath, JSON.stringify(entry) + '\n')
      } catch (err) {
        console.warn(`[setupMailboxBridge] failed to write to ${filePath}:`, err)
      }
    },
    teardown() {
      if (disposed) return
      disposed = true
    },
  }
}
