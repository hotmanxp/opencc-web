// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P1): L1 hook adapter — setupSwarmInitialization.
 * Minimal team initialization. P1 covers createTeammate + teardown.
 * Full teammate lifecycle (status updates, exit hooks) lands in P2.
 */

import { randomUUID } from 'crypto'

type SetupSwarmInitializationOpts = {
  sessionId: string
  teamName?: string
  onTeammateCreated: (id: string) => void
}

const teammates = new Map<string, { name: string; role: string; createdAt: number }>()

export function setupSwarmInitialization(opts: SetupSwarmInitializationOpts) {
  let disposed = false

  return {
    createTeammate(name: string, role: string): string {
      if (disposed) throw new Error(`[setupSwarmInitialization] disposed`)
      const id = `${opts.sessionId}:${name}:${randomUUID().slice(0, 8)}`
      teammates.set(id, { name, role, createdAt: Date.now() })
      opts.onTeammateCreated(id)
      return id
    },
    teardown() {
      disposed = true
      // Don't clear module-level map (other sessions may still reference)
    },
    listTeammates() {
      return Array.from(teammates.entries()).map(([id, t]) => ({ id, ...t }))
    },
  }
}
