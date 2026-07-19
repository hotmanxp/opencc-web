/**
 * runtime/compact 公共 API facade。
 *
 * 内部模块互不依赖,统一通过这里 export。
 * 后续 stage(D/E/F)的 reactive compact / compact command v2 / resume support
 * 也从这里 export。
 */

// ---- 触发判定 ----
export {
  getEffectiveContextWindowSize,
  getAutoCompactThreshold,
  calculateTokenWarningState,
  isAutoCompactEnabled,
  AUTOCOMPACT_BUFFER_TOKENS,
  WARNING_THRESHOLD_BUFFER_TOKENS,
  ERROR_THRESHOLD_BUFFER_TOKENS,
  MANUAL_COMPACT_BUFFER_TOKENS,
} from './context-window.js'

// ---- Circuit breaker ----
export {
  resolveAutoCompactCircuitBreakerState,
  getAutoCompactFailureCooldownMs,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  AUTOCOMPACT_FAILURE_COOLDOWN_MS,
  MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS,
} from './tracking.js'

// ---- 主动压缩 ----
export {
  snipCompactIfNeeded,
} from './snip.js'

export {
  resolveForceReason,
  validateBoundedIntEnvVar,
  consumeCompactionRequest,
  setCompactionRequest,
  FORCE_FLOOR_PCT_DEFAULT,
  FORCE_FLOOR_PCT_MAX,
} from './force-reason.js'

export {
  autoCompactIfNeeded,
  shouldAutoCompact,
} from './autocompact.js'

export type { AutoCompactResult } from './autocompact.js'

// ---- Compact 执行 ----
export {
  compactConversation,
  buildPostCompactMessages,
} from './conversation.js'

// ---- Cleanup ----
export {
  runPostCompactCleanup,
  markPostCompaction,
  consumePostCompactMarker,
} from './cleanup.js'

// ---- Log ----
export {
  logEvent,
  readCompactLog,
} from './log-event.js'
export type { CompactLogEntry } from './log-event.js'

// ---- Types ----
export type {
  CompactTrigger,
  ForceReason,
  AutoCompactTrackingState,
  CircuitBreakerAction,
  CompactionResult,
  CompactSessionOptions,
  CompactSessionResult,
  TokenWarningState,
} from './types.js'
