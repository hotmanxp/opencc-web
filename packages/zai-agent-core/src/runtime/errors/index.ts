/**
 * A. 错误分类 + Max output tokens 自愈 + Tool 死循环防护 + Reactive compact
 * — re-export facade。
 *
 * 主 session 在 Phase 2 把这些串入 queryLoop.ts(不在本 Agent 范围)。
 * 本 index 暴露稳定 API,供 Phase 2 wire-in PR 使用。
 */

export {
  classifyApiError,
  type ErrorKind,
  type ClassifiedError,
} from './classification.js'

export {
  recoverMaxOutputTokens,
  type MaxTokensRecoveryOptions,
} from './maxOutputTokens.js'

export {
  recordToolFailure,
  recordToolSuccess,
  type LoopGuardState,
  type LoopGuardDecision,
} from './loopGuard.js'

export {
  tryReactiveCompact,
  type ReactiveCompactResult,
} from './reactiveCompact.js'