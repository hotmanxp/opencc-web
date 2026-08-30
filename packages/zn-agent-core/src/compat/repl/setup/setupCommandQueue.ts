// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L0 hook adapter — setupCommandQueue.
 * Wraps messageQueueManager as imperative API; same module-level state
 * as useCommandQueue (one queue, two callers).
 *
 * zai patch (2026-08-30, plan P3): append parseSlashCommand +
 * KNOWN_SLASH_COMMANDS + isKnownSlashCommand. P3 routes /-prefixed
 * prompts in ReplRuntime.query() to stub handlers that emit
 * runtime.notification + runtime.done instead of going through the
 * normal turn loop (which previously threw runtime.error for slash
 * commands — Path 4/7/8 fail in 12-path verification).
 */

import {
  getCommandQueue,
  dequeue,
  enqueue,
} from '../../../opencc-src/utils/messageQueueManager.js'

/**
 * zai patch (2026-08-30, plan P3): parseSlashCommand — extract command
 * name and args from a /-prefixed prompt. Returns null for non-slash
 * input or empty slash. Quote-aware arg splitting (single + double
 * quotes preserve spaces).
 */
export type ParsedSlashCommand = {
  command: string
  args: string[]
  raw: string
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const withoutSlash = trimmed.slice(1)
  // Tokenize with quote awareness (single + double quotes preserve spaces)
  const tokens: string[] = []
  let current = ''
  let inQuote: '"' | "'" | null = null
  for (const ch of withoutSlash) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current.length > 0) tokens.push(current)
  const [command, ...args] = tokens
  if (!command) return null
  return { command, args, raw: trimmed }
}

/**
 * zai patch (2026-08-30, plan P3): whitelist of slash commands the
 * ReplRuntime stub actually handles. Unknown commands emit
 * `kind: 'unknown-command'` notification instead of routing.
 */
export const KNOWN_SLASH_COMMANDS = ['loop', 'swarm', 'send'] as const
export type KnownSlashCommand = typeof KNOWN_SLASH_COMMANDS[number]

export function isKnownSlashCommand(cmd: string): cmd is KnownSlashCommand {
  return (KNOWN_SLASH_COMMANDS as readonly string[]).includes(cmd)
}

type QueuedCommand = {
  value: string | Array<unknown>
  mode: 'bash' | 'prompt' | 'orphaned-permission' | 'task-notification'
  priority?: 'now' | 'next' | 'later'
  uuid?: string
  isMeta?: boolean
}

type SetupCommandQueueOpts = {
  onChange?: () => void
}

type SetupCommandQueue = {
  enqueue(cmd: QueuedCommand): void
  drain(): QueuedCommand[]
  peek(): QueuedCommand[]
  teardown(): void
}

export function setupCommandQueue(opts: SetupCommandQueueOpts = {}): SetupCommandQueue {
  let disposed = false
  let interval: NodeJS.Timeout | null = null

  // Light polling for onChange (P0 OK; P1 spike can replace with vendor
  // subscribeToCommandQueue if exposed). 100ms is plenty for L0.
  if (opts.onChange) {
    let lastLen = getCommandQueue().length
    interval = setInterval(() => {
      if (disposed) return
      const cur = getCommandQueue().length
      if (cur !== lastLen) {
        lastLen = cur
        opts.onChange!()
      }
    }, 100)
    interval.unref?.()
  }

  return {
    enqueue(cmd) {
      if (disposed) return
      // Push directly to the module-level queue via vendor helper
      // (matches useCommandQueue behavior).
      enqueue(cmd)
    },
    drain() {
      const drained: QueuedCommand[] = []
      let cmd
      while ((cmd = dequeue()) !== undefined) {
        drained.push(cmd as QueuedCommand)
      }
      return drained
    },
    peek() {
      return [...getCommandQueue()] as QueuedCommand[]
    },
    teardown() {
      if (disposed) return
      disposed = true
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    },
  }
}
