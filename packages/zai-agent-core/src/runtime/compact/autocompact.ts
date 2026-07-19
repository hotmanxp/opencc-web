/**
 * 自动压缩主入口。
 *
 * 流程:
 *   shouldAutoCompact → resolveAutoCompactCircuitBreakerState →
 *   compactConversation → runPostCompactCleanup → logEvent
 *
 * 失败 → 递增 consecutiveFailures + 触发 cooldown。
 */

import type { TranscriptMessage } from '../../transcript/types.js'
import type { AutoCompactTrackingState, ForceReason } from './types.js'
import { getAutoCompactThreshold } from './context-window.js'
import {
  getAutoCompactFailureCooldownMs,
  resolveAutoCompactCircuitBreakerState,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
} from './tracking.js'
import { compactConversation } from './conversation.js'
import { runPostCompactCleanup } from './cleanup.js'
import { logEvent } from './log-event.js'

// 本地最小 token 估算 — 阶段 1 简化:每条 message 的 content 长度 / 4 估 token
// 阶段 2 再用更精确的实现替换
function tokenCountWithEstimation(messages: TranscriptMessage[]): number {
  let total = 0
  for (const m of messages) {
    const content = m.message?.content
    if (typeof content === 'string') {
      total += Math.ceil(content.length / 4)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'object' && block !== null) {
          const b = block as { text?: string; thinking?: string; content?: unknown }
          if (typeof b.text === 'string') total += Math.ceil(b.text.length / 4)
          if (typeof b.thinking === 'string') total += Math.ceil(b.thinking.length / 4)
        }
      }
    }
  }
  return total
}

type ToolUseContext = {
  options: { mainLoopModel: string }
  abortController: AbortController
}
type CacheSafeParams = {
  systemPrompt: unknown
  userContext: Record<string, unknown>
  systemContext: Record<string, unknown>
  toolUseContext: unknown
  forkContextMessages: TranscriptMessage[]
}

export interface AutoCompactResult {
  wasCompacted: boolean
  consecutiveFailures?: number
  nextRetryAtMs?: number
  lastFailureAtMs?: number
  circuitBreakerActive?: boolean
  circuitBreakerTripped?: boolean
}

export async function shouldAutoCompact(
  messages: TranscriptMessage[],
  model: string,
  querySource: string,
  snipTokensFreed: number = 0,
  forceReason?: ForceReason,
): Promise<boolean> {
  if (querySource === 'compact' || querySource === 'session_memory') return false

  if (!forceReason) {
    if (process.env.ZAI_DISABLE_COMPACT === '1') return false
    if (process.env.ZAI_DISABLE_AUTO_COMPACT === '1') return false
  }

  if (forceReason) return true

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  return tokenCount >= threshold
}

export async function autoCompactIfNeeded(
  messages: TranscriptMessage[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource: string,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed: number = 0,
  nowMs: number = Date.now(),
): Promise<AutoCompactResult> {
  const model = toolUseContext.options.mainLoopModel
  const forcedBy = tracking?.forceReason
  if (tracking?.forceReason) tracking.forceReason = undefined
  if (!forcedBy && process.env.ZAI_DISABLE_AUTO_COMPACT === '1') {
    return { wasCompacted: false }
  }

  const should = await shouldAutoCompact(messages, model, querySource, snipTokensFreed, forcedBy)
  if (!should) {
    return { wasCompacted: false }
  }

  const cooldownMs = getAutoCompactFailureCooldownMs()
  const breaker = resolveAutoCompactCircuitBreakerState({
    tracking,
    nowMs,
    cooldownMs,
  })

  if (breaker.action === 'skip') {
    return {
      wasCompacted: false,
      consecutiveFailures: breaker.consecutiveFailures,
      nextRetryAtMs: breaker.nextRetryAtMs,
      circuitBreakerActive: true,
    }
  }

  const start = Date.now()
  try {
    const result = await compactConversation(
      messages,
      toolUseContext as any,
      cacheSafeParams,
      true,
      undefined,
      true,
    )

    runPostCompactCleanup(querySource)
    logEvent('z auto_compact_succeeded', {
      ts: Date.now(),
      sessionId: messages[0]?.sessionId ?? 'unknown',
      trigger: 'auto',
      model,
      preCompactTokens: result.preCompactTokenCount,
      postCompactTokens: result.postCompactTokenCount,
      savedTokens:
        (result.preCompactTokenCount ?? 0) - (result.postCompactTokenCount ?? 0),
      circuitBreakerState: breaker.wasHalfOpen ? 'half-open' : 'closed',
      consecutiveFailures: breaker.effectiveConsecutiveFailures,
      durationMs: Date.now() - start,
      error: null,
    })

    return {
      wasCompacted: true,
      consecutiveFailures: 0,
    }
  } catch (error) {
    const failureAtMs = Date.now()
    const nextFailures = Math.min(
      breaker.effectiveConsecutiveFailures + 1,
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    )
    const circuitBreakerTripped =
      nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
    const nextRetryAtMs = circuitBreakerTripped ? failureAtMs + cooldownMs : undefined

    logEvent('z auto_compact_failed', {
      ts: failureAtMs,
      sessionId: messages[0]?.sessionId ?? 'unknown',
      trigger: 'auto',
      model,
      circuitBreakerState: circuitBreakerTripped ? 'open' : 'closed',
      consecutiveFailures: nextFailures,
      durationMs: failureAtMs - start,
      error: (error as Error).message.slice(0, 200),
    })

    return {
      wasCompacted: false,
      consecutiveFailures: nextFailures,
      nextRetryAtMs,
      lastFailureAtMs: failureAtMs,
      circuitBreakerActive: circuitBreakerTripped,
      circuitBreakerTripped,
    }
  }
}