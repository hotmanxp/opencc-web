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

export { serializeForCompact } from './serialize-for-compact.js'
export { estimateMessagesTokenCount } from './token-estimate.js'
export { truncateHeadForPTLRetry, getPromptTooLongTokenGap } from './ptl-retry.js'
export { isCompactionCacheSharingCompatible } from './prompt-cache-share.js'
export {
  executePreCompactHooks,
  executePostCompactHooks,
  HOOK_TIMEOUT_MS,
  type PreCompactHookInput,
  type PostCompactHookInput,
  type CompactHookTrigger,
} from './hooks.js'

// ---- /compact 命令 shim(替换 runtime/compactService.ts) ----

import type { TranscriptStore } from '../../transcript/store.js'
import type { ModelCaller } from '../types.js'
import type { CompactSessionOptions, CompactSessionResult } from './types.js'
import { compactConversation, buildPostCompactMessages } from './conversation.js'
import { isCompactionCacheSharingCompatible } from './prompt-cache-share.js'
import { truncateHeadForPTLRetry } from './ptl-retry.js'
import { getEffectiveContextWindowSize } from './context-window.js'

const PTL_RETRY_MAX = 3

export async function compactSession(
  opts: CompactSessionOptions,
): Promise<CompactSessionResult> {
  const { store, sessionId, modelCaller, cwd, model, providerKind } = opts

  const file = await store.read(sessionId, { cwd })
  if (file.messages.length < 2) {
    return { kind: 'error', message: `对话太短, 无需压缩 (当前 ${file.messages.length} 条, 至少需要 2 条)` }
  }

  const cacheSafeParams = {
    systemPrompt: undefined as unknown,
    userContext: {},
    systemContext: {},
    toolUseContext: {
      options: { mainLoopModel: model ?? 'MiniMax-M3' },
      abortController: new AbortController(),
      modelCaller: modelCaller as any,
    },
    forkContextMessages: [],
  }

  let attempt = 0
  let messages = file.messages
  let result
  while (true) {
    try {
      result = await compactConversation(
        messages,
        cacheSafeParams.toolUseContext,
        cacheSafeParams,
        true,
        undefined,
        false,
        providerKind ?? 'openai',
      )
      break
    } catch (err) {
      const e = err as Error & { code?: string; ptlResponse?: { usage?: { output_tokens?: number } } }
      if (e.code !== 'prompt_too_long' || attempt >= PTL_RETRY_MAX) {
        return { kind: 'error', message: `生成摘要失败: ${e.message.slice(0, 200)}` }
      }
      const ctx = getEffectiveContextWindowSize(model ?? 'MiniMax-M3')
      const truncated = truncateHeadForPTLRetry(messages, e.ptlResponse ?? {}, ctx)
      if (!truncated) {
        return { kind: 'error', message: '对话历史过长, 无法压缩(已尝试 3 次)' }
      }
      messages = truncated
      attempt++
    }
  }

  // shim 不写盘(对齐旧 compactService.ts + builtin/compact.ts:67 调用方语义)
  // 对齐旧 compactSession contract:
  //   - newMessages = [...original, boundary, summary] (buildPostCompactMessages 只返回 boundary+summary+hooks)
  //   - boundaryMarker.type 强制覆盖为 'compact_boundary' (旧 contract; conversation.ts 写 'system')
  void isCompactionCacheSharingCompatible // dual path 决策点保留,详细 cache params 走阶段 3
  const summaryText = (result.summaryMessages[0]?.message as any)?.content?.[0]?.text ?? ''
  const tail = buildPostCompactMessages(result).map((m, i) =>
    i === 0 ? { ...m, type: 'compact_boundary' as const } : m,
  )
  const newMessages = [...file.messages, ...tail]
  return { kind: 'compacted', summary: summaryText, newMessages }
}
