import { subscribeToCommandQueue } from './messageQueueManager.js'

export interface HeadlessWakeOptions {
  /** Returns true when it's safe to call `onWake`. Usually `!running && !inputClosed`. */
  shouldWake: () => boolean
  /** True if there's a queued main-thread command (prompt / task-notification). */
  hasMainThreadQueued: () => boolean
  /** True if there's a non-teammate background task currently running. */
  getBgRunning: () => boolean
  /** Called when the loop should re-evaluate. Guarded by mutex `shouldWake()`. */
  onWake: () => void
}

/**
 * Subscribe to command-queue changes and wake the headless loop on demand.
 *
 * Replaces the legacy `cli/print.ts` `do-while(waitingForAgents)` polling
 * pattern (`print.ts:2568-2608`). The legacy loop slept 100ms between
 * iterations and could exit before `enqueueAgentNotification` enqueued the
 * `<task-notification>` for a completed background agent — leaving the
 * notification stranded with no consumer. Event-driven wake eliminates that
 * race: every enqueue fires `subscribeToCommandQueue`, which checks the
 * wake conditions synchronously and dispatches `onWake()` if work exists.
 *
 * Per-session: the caller passes `getAppState` / `getBgRunning` /
 * `hasMainThreadQueued` as closures bound to its own AppState instance,
 * so zai's inproc multi-session mode stays isolated — a wake on session A
 * never triggers session B.
 *
 * Mirror of REPL's `hooks/useQueueProcessor.ts::useQueueProcessor` shape,
 * minus the React `useSyncExternalStore` plumbing (we run in plain Node).
 *
 * @returns Unsubscribe. Caller should pipe through `registerCleanup`
 *          so per-session listeners don't leak.
 */
export function subscribeToHeadlessWake(opts: HeadlessWakeOptions): () => void {
  return subscribeToCommandQueue(() => {
    if (!opts.shouldWake()) return
    if (opts.hasMainThreadQueued() || opts.getBgRunning()) opts.onWake()
  })
}