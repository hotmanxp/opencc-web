/**
 * C — Continuation nudge + Stop-hook blocking (spec C).
 *
 * Re-export facade for the three C sub-modules. Wire-in (Phase 2 in
 * `queryLoop.ts`) imports from this entry point to keep surface area
 * minimal and namespaced.
 */

export {
  analyzeContinuationIntent,
} from './analyze.js'
export type {
  ContinuationIntent,
  LastBlockKind,
} from './analyze.js'

export {
  injectContinuationNudge,
  DEFAULT_CONTINUATION_NUDGE_MAX,
  CONTINUATION_NUDGE_TEXT,
} from './inject.js'
export type {
  NudgeCounters,
  InjectNudgeOptions,
  InjectNudgeResult,
  InjectNudgeReason,
} from './inject.js'

export {
  HookBlockedError,
  isHookBlockedError,
  buildHookBlockedErrorPayload,
} from './hooks.js'
export type {
  StopHookPayload,
  HookBlockedErrorPayload,
} from './hooks.js'