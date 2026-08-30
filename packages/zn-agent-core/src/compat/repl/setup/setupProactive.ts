// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L1 hook adapter — setupProactive.
 * Imperative wrapper over vendor useProactive internals.
 * Mirrors useProactive imperative side: GrowthBook PROACTIVE/KAIROS gate,
 * internal timer (interval may be conditional on GrowthBook gate).
 *
 * NOTE: useProactive.ts does not exist as a vendor file in this build;
 * the hook is gated by `false || false` in REPL.tsx (dead code elimination).
 * This adapter extracts the imperative logic that would be behind that hook.
 */

import { subscribeToProactiveChanges } from '../../../opencc-src/proactive/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../../opencc-src/services/analytics/growthbook.js'

type SetupProactiveOpts = {
  sessionId: string
  isLoading: () => boolean
  queuedCommandsLength: () => number
  hasActiveLocalJsxUI?: () => boolean
  isInPlanMode?: () => boolean
  onSubmitTick?: (prompt: string) => void
  onQueueTick?: (prompt: string) => void
}

type SetupProactive = {
  teardown(): void
}

/**
 * Check if the PROACTIVE or KAIROS GrowthBook feature gate is enabled.
 * Mirrors the `feature('PROACTIVE') || feature('KAIROS')` check in AgentTool.tsx
 * (where feature() is bun:bundle, which doesn't exist in Node.js).
 */
function isProactiveGrowthBookEnabled(): boolean {
  return (
    getFeatureValue_CACHED_MAY_BE_STALE('PROACTIVE', false) ||
    getFeatureValue_CACHED_MAY_BE_STALE('KAIROS', false)
  )
}

export function setupProactive(opts: SetupProactiveOpts): SetupProactive {
  let timer: NodeJS.Timeout | null = null
  let disposed = false
  let unsubscribe: (() => void) | null = null

  if (isProactiveGrowthBookEnabled()) {
    // Subscribe to proactive state changes
    unsubscribe = subscribeToProactiveChanges(() => {
      // State changed — could fire ticks here if needed
    })

    // P0: 30s placeholder interval (matches plan brief; vendor may use different)
    timer = setInterval(() => {
      if (disposed) return
      if (opts.isLoading()) return
      if (opts.hasActiveLocalJsxUI?.()) return
      if (opts.isInPlanMode?.()) return

      // P0: placeholder — actual proactive tick source lands in P1
      // The callbacks are provided for P1 wiring
      if (opts.queuedCommandsLength() === 0) {
        opts.onSubmitTick?.('')
      } else {
        opts.onQueueTick?.('')
      }
    }, 30_000)
    timer.unref?.()
  }

  return {
    teardown() {
      if (disposed) return
      disposed = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    },
  }
}