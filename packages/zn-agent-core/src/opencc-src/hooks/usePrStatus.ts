import { useEffect, useState } from 'react'
import type { PrReviewState } from '../utils/ghPrStatus.js'

export type PrStatusState = {
  number: number | null
  url: string | null
  reviewState: PrReviewState | null
  lastUpdated: number
}

const INITIAL_STATE: PrStatusState = {
  number: null,
  url: null,
  reviewState: null,
  lastUpdated: 0,
}

/**
 * Polls PR review status every 60s while the session is active.
 * When no interaction is detected for 60 minutes, the loop stops — no
 * timers remain. React re-runs the effect when isLoading changes
 * (turn starts/ends), restarting the loop. Effect setup schedules
 * the next poll relative to the last fetch time so turn boundaries
 * don't spawn `gh` more than once per interval. Disables permanently
 * if a fetch exceeds 4s.
 *
 * Pass `enabled: false` to skip polling entirely (hook still must be
 * called unconditionally to satisfy the rules of hooks).
 */
export function usePrStatus(isLoading: boolean, enabled = true): PrStatusState {
  const [prStatus] = useState<PrStatusState>(INITIAL_STATE)

  useEffect(() => {
    // DISABLED 2026-06-06: PR status polling is disabled at the source.
    // See ghPrStatus.ts and ghAuthStatus.ts for the matching disables.
    // The hook signature is preserved so caller (PromptInputFooterLeftSide)
    // and tests continue to compile. Effect returns without scheduling
    // any setTimeout or fetch — no `gh` process will ever be spawned.
    return undefined
  }, [isLoading, enabled])

  return prStatus
}

