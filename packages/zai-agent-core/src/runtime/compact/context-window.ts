/**
 * 上下文窗口 + 自动压缩阈值计算。
 *
 * 模型上下文窗口 → 减去 output reservation → 减去 13k autocompact buffer
 * = 有效自动压缩阈值。
 *
 * 镜像 spec §1 / §3.4 / OpenCC `autoCompact.ts` 但完全独立实现。
 */

/**
 * zai 支持的 model context window 表(per spec §3.1 + AGENTS.md §启动所需环境)
 *
 * 阶段 1:只支持 MiniMax-M3(200k context)。后续 stage 再扩展其他 model。
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'MiniMax-M3': 200_000,
}

const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'MiniMax-M3': 8_000,
}

function getContextWindowForModel(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? 200_000  // 默认 200k 兜底
}

function getMaxOutputTokensForModel(model: string): number {
  return MODEL_MAX_OUTPUT_TOKENS[model] ?? 8_000
}

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

/**
 * 上下文窗口 - max_output_for_summary,带 13k buffer floor
 * 避免负数 / 极小阈值(issue #635)
 */
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  const contextWindow = getContextWindowForModel(model)

  const effectiveContext = contextWindow - reservedTokensForSummary
  return Math.max(effectiveContext, reservedTokensForSummary + AUTOCOMPACT_BUFFER_TOKENS)
}

/**
 * 自动压缩触发阈值 = eff - 13k buffer
 * (留 13k 给压缩后的对话 + summary)
 */
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  const autocompactThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS

  const envPercent = process.env.ZAI_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(effectiveContextWindow * (parsed / 100))
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

export interface TokenWarningState {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
}

export function calculateTokenWarningState(tokenUsage: number, model: string): TokenWarningState {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)
  const rawContextWindow = effectiveWindow + getMaxOutputTokensForModel(model)

  const percentLeft = Math.max(
    0,
    Math.round(((rawContextWindow - tokenUsage) / rawContextWindow) * 100),
  )

  const warningThreshold = autoCompactThreshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = autoCompactThreshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold
  const blockingLimit = effectiveWindow - MANUAL_COMPACT_BUFFER_TOKENS
  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold: tokenUsage >= warningThreshold,
    isAboveErrorThreshold: tokenUsage >= errorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (process.env.ZAI_DISABLE_COMPACT === '1') return false
  if (process.env.ZAI_DISABLE_AUTO_COMPACT === '1') return false
  return true
}
