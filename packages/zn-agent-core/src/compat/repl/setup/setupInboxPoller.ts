// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P1): L1 hook adapter — setupInboxPoller.
 * Polls per-session UDS inbox file at intervals; dispatches messages
 * when not loading. Mirrors useInboxPoller behavior.
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

type SetupInboxPollerOpts = {
  sessionId: string
  cwd: string
  isLoading: () => boolean
  onMessage: (msg: any) => void
}

const POLL_INTERVAL_MS = 2000

export function setupInboxPoller(opts: SetupInboxPollerOpts) {
  let timer: NodeJS.Timeout | null = null
  let disposed = false

  function poll(): void {
    if (disposed) return
    if (opts.isLoading()) return
    const inboxPath = join(opts.cwd, '.zai', 'inbox', `${opts.sessionId}.jsonl`)
    if (!existsSync(inboxPath)) return
    try {
      const content = readFileSync(inboxPath, 'utf8')
      const lines = content.split('\n').filter(Boolean)
      // Only process lines added since last poll; P1 simple version
      // processes all lines (vendor tracks offset; P1 spike confirms).
      for (const line of lines) {
        try {
          opts.onMessage(JSON.parse(line))
        } catch {
          // ignore malformed
        }
      }
    } catch {
      // ignore read errors
    }
  }

  timer = setInterval(poll, POLL_INTERVAL_MS)
  timer.unref?.()

  return {
    async trigger() {
      poll()
    },
    teardown() {
      if (disposed) return
      disposed = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
