/**
 * CwdStore — singleton tracking per-session logical cwd.
 *
 * zai multi-session model: each session has its own cwd, stored by sessionId.
 * Replaces the in-memory Map that zai-agent-core used. Backed by opencc's
 * BashProvider cwd trailer reading.
 */

import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export type CwdEntry = { cwd: string; updatedAt: number }

class CwdStoreImpl {
  private map = new Map<string, CwdEntry>()

  get(sessionId: string): CwdEntry | undefined {
    return this.map.get(sessionId)
  }

  set(sessionId: string, cwd: string): void {
    this.map.set(sessionId, { cwd, updatedAt: Date.now() })
  }

  delete(sessionId: string): void {
    this.map.delete(sessionId)
  }

  /**
   * Read the cwd trailer file produced by opencc's BashProvider.
   * OpenCC writes `/tmp/claude-<taskId>-cwd` (via os.tmpdir()) after each sh -c
   * (see `src/utils/shell/bashProvider.ts` — `nativeJoin(tmpdir, 'claude-${opts.id}-cwd')`).
   * The `claude-` prefix is the upstream Claude Code convention carried over.
   */
  readTrailer(taskId: string): string | undefined {
    try {
      return readFileSync(join(tmpdir(), `claude-${taskId}-cwd`), 'utf-8').trim()
    } catch {
      return undefined
    }
  }

  clear(): void {
    this.map.clear()
  }
}

export const CwdStore = new CwdStoreImpl()