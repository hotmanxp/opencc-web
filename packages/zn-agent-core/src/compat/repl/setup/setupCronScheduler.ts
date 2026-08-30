// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L1 hook adapter — setupScheduledTasks.
 * Imperative wrapper over vendor useScheduledTasks internals
 * (createCronScheduler + enqueuePendingNotification).
 */

import { createCronScheduler, type CronScheduler } from '../../../opencc-src/utils/cronScheduler.js'
import { enqueuePendingNotification } from '../../../opencc-src/utils/messageQueueManager.js'
import { isKairosCronEnabled } from '../../../opencc-src/tools/ScheduleCronTool/prompt.js'

type SetupScheduledTasksOpts = {
  sessionId: string
  getAppState: () => unknown
  isLoading: () => boolean
  assistantMode?: boolean
  onFireTask?: (task: any) => void
  onMissed?: (tasks: any[]) => void
}

type SetupScheduledTasks = {
  teardown(): void
  subscribe(cb: (prompt: string) => void): () => void
}

export function setupScheduledTasks(opts: SetupScheduledTasksOpts): SetupScheduledTasks {
  const subs = new Set<(prompt: string) => void>()
  let scheduler: CronScheduler | null = null

  if (isKairosCronEnabled()) {
    scheduler = createCronScheduler({
      onFire: prompt => {
        enqueuePendingNotification({
          value: prompt,
          mode: 'prompt',
          priority: 'later',
          isMeta: true,
        })
        for (const cb of subs) cb(prompt)
      },
      onFireTask: opts.onFireTask,
      onMissed: opts.onMissed,
      isLoading: opts.isLoading,
      assistantMode: opts.assistantMode ?? false,
      isKilled: () => !isKairosCronEnabled(),
    })
    scheduler.start()
  }

  return {
    teardown() {
      if (scheduler) {
        scheduler.stop()
        scheduler = null
      }
      subs.clear()
    },
    subscribe(cb) {
      subs.add(cb)
      return () => { subs.delete(cb) }
    },
  }
}
