// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L0 hook adapter — setupCommandQueue.
 * Wraps messageQueueManager as imperative API; same module-level state
 * as useCommandQueue (one queue, two callers).
 */

import {
  getCommandQueue,
  dequeue,
  enqueue,
} from '../../../opencc-src/utils/messageQueueManager.js'

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
