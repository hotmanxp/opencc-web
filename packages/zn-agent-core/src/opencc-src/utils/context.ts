// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.ts'
import { getGlobalConfig } from './config.ts'
import { isEnvTruthy } from './envUtils.ts'
import { getCanonicalName } from './model/model.ts'
import { getModelCapability } from './model/modelCapabilities.ts'
import { getOpenAIContextWindow, getOpenAIMaxOutputTokens } from './model/openaiContextWindows.ts'
import { resolveAntModel } from './model/antModels.ts'
import { resolveModelRuntimeLimits } from '../integrations/runtimeMetadata.js'
import { logForDebugging } from './debug.ts'
import {
  getTransportKindForRoute,
  resolveActiveRouteIdFromEnv,
} from '../integrations/routeMetadata.js'

// Model context window size (200k tokens for all models right now)
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Fallback context window for unknown 3P models. Must be large enough that
// the effective context (this minus output token reservation) stays positive,
// otherwise auto-compact fires on every message (issue #635).
// Override via CLAUDE_CODE_OPENAI_FALLBACK_CONTEXT_WINDOW env var to avoid
// hardcoding when deploying models not yet in openaiContextWindows.ts.
export const OPENAI_FALLBACK_CONTEXT_WINDOW = (() => {
  const v = parseInt(process.env.CLAUDE_CODE_OPENAI_FALLBACK_CONTEXT_WINDOW ?? '', 10)
  return !isNaN(v) && v > 0 ? v : 128_000
})()

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// claude.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

// Session-scoped context window overrides (abordagem C: module-level state)
// Key: normalized model name (lowercase, prefix stripped)
// Value: context window in tokens
const sessionContextWindowOverrides = new Map<string, number>()

// Minimum context window to avoid auto-compact floor paradox
// (reservedTokensForSummary + autocompactBuffer = 20k + 13k = 33k)
const MIN_CONTEXT_WINDOW_OVERRIDE = 33_000

/**
 * Normalize a model name for override lookup to get a single canonical key
 * for the model family (lowercase, prefix stripped).
 */
function normalizeModelName(model: string): string {
  const lowered = model.toLowerCase()
  const stripped = stripProviderPrefix(lowered)
  return stripped !== undefined ? stripped : lowered
}

/**
 * Strip a leading provider prefix (e.g. openai/, anthropic/) for fallback lookup.
 */
function stripProviderPrefix(model: string): string | undefined {
  const stripped = model.replace(/^[a-z][\w-]*\//, '')
  return stripped !== model ? stripped : undefined
}

/**
 * Set a session-scoped context window override for a specific model.
 * Used by the /set_context_window slash command.
 * The override is in-memory only and dies with the session.
 *
 * Returns the normalized model key used for storage.
 */
export function setSessionContextWindowOverride(
  model: string,
  tokens: number,
): { ok: true; normalizedModel: string } | { ok: false; error: string } {
  if (!Number.isFinite(tokens) || !Number.isInteger(tokens) || tokens <= 0) {
    return { ok: false, error: 'Context window must be a positive integer' }
  }
  if (tokens < MIN_CONTEXT_WINDOW_OVERRIDE) {
    return {
      ok: false,
      error: `Context window must be at least ${MIN_CONTEXT_WINDOW_OVERRIDE} tokens (current: ${tokens})`,
    }
  }
  const normalized = normalizeModelName(model)
  sessionContextWindowOverrides.set(normalized, tokens)
  return { ok: true, normalizedModel: normalized }
}

/**
 * Clear session-scoped context window overrides.
 * If model is provided, clears the canonical key for the model family.
 * If model is omitted, clears all overrides.
 */
export function clearSessionContextWindowOverride(model?: string): void {
  if (model) {
    const normalized = normalizeModelName(model)
    sessionContextWindowOverrides.delete(normalized)
  } else {
    sessionContextWindowOverrides.clear()
  }
}

/**
 * Get the current session-scoped context window override for a model, if any.
 * Resolves to the canonical key for the model family.
 */
export function getSessionContextWindowOverride(
  model: string,
): number | undefined {
  const normalized = normalizeModelName(model)
  return sessionContextWindowOverrides.get(normalized)
}

/**
 * Get all current session-scoped context window overrides.
 * Returns a copy of the internal map.
 */
export function getSessionContextWindowOverrides(): Map<string, number> {
  return new Map(sessionContextWindowOverrides)
}

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

// @[MODEL LAUNCH]: Update this pattern if the new model supports 1M context
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  const canonical = getCanonicalName(model)
  return canonical.includes('claude-sonnet-4') || canonical.includes('opus-4-6')
}

function shouldUseIntegrationRuntimeLimits(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const routeId = resolveActiveRouteIdFromEnv(processEnv)
  const transportKind = routeId ? getTransportKindForRoute(routeId) : null

  return (
    transportKind === 'openai-compatible' ||
    transportKind === 'anthropic-proxy' ||
    transportKind === 'local' ||
    transportKind === 'gemini-native'
  )
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // Allow override via environment variable (internal-only)
  // This takes precedence over all other context window resolution, including 1M detection,
  // so users can cap the effective context window for local decisions (auto-compact, etc.)
  // while still using a 1M-capable endpoint.
  if (
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  ) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // Session-scoped override (set by /set_context_window) takes precedence
  // over the [1m] suffix and all static lookup paths below. Only the
  // ant+CLAUDE_CODE_MAX_CONTEXT_TOKENS hard cap above wins.
  // The [1m] suffix is stripped before lookup so an override registered on
  // the bare model name (e.g. `claude-sonnet-4-6`) also applies when the
  // caller passes `claude-sonnet-4-6[1m]`.
  const sessionOverride = getSessionContextWindowOverride(
    model.replace(/\[1m\]$/i, ''),
  )
  if (sessionOverride !== undefined) {
    return sessionOverride
  }

  // [1m] suffix — explicit client-side opt-in, respected over all detection
  if (has1mContext(model)) {
    return 1_000_000
  }

  // OpenAI-compatible provider — use known context windows for the model.
  // Unknown models get a conservative 128k default. This was previously 8k,
  // but that caused auto-compact to fire on every turn because the effective
  // context (8k minus output reservation) became negative (issue #635).
  if (shouldUseIntegrationRuntimeLimits()) {
    const runtimeLimits = resolveModelRuntimeLimits({ model })
    if (runtimeLimits.contextWindow !== undefined) {
      return runtimeLimits.contextWindow
    }
    logForDebugging(
      `[context] Warning: model "${model}" not in integration model metadata — using conservative 128k default. ` +
        'Add it to src/integrations/models for accurate compaction.',
      { level: 'warn' },
    )
    return OPENAI_FALLBACK_CONTEXT_WINDOW
  }

  // Legacy env var override (for custom deployments not yet in integration metadata)
  const openaiWindow = getOpenAIContextWindow(model)
  if (openaiWindow !== undefined) {
    return openaiWindow
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return cap.max_input_tokens
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000
  }
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return 1_000_000
  }
  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model)
    if (antModel?.contextWindow) {
      return antModel.contextWindow
    }
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // Only applies to sonnet 4.6 without an explicit [1m] suffix
  if (has1mContext(model)) {
    return false
  }
  if (!getCanonicalName(model).includes('sonnet-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  let defaultTokens: number
  let upperLimit: number

  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model.toLowerCase())
    if (antModel) {
      defaultTokens = antModel.defaultMaxTokens ?? MAX_OUTPUT_TOKENS_DEFAULT
      upperLimit = antModel.upperMaxTokensLimit ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT
      return { default: defaultTokens, upperLimit }
    }
  }

  // OpenAI-compatible provider — use known output limits to avoid 400 errors
  if (shouldUseIntegrationRuntimeLimits()) {
    const runtimeLimits = resolveModelRuntimeLimits({ model })
    if (runtimeLimits.maxOutputTokens !== undefined) {
      return {
        default: runtimeLimits.maxOutputTokens,
        upperLimit: runtimeLimits.maxOutputTokens,
      }
    }
  }

  // Model-name keyed fallback (mirrors getContextWindowForModel above).
  // Route-independent so 3P models served via anthropic-proxy (e.g. zn-nova
  // MiniMax-M3) resolve their descriptor limits even when
  // shouldUseIntegrationRuntimeLimits() returns false. OpenCC native models
  // have no entry in OPENAI_MAX_OUTPUT_TOKENS (intentionally omitted per the
  // bare-OpenCC-name note in openaiContextWindows.ts) and fall through to
  // the canonical-name if/else chain below.
  const openaiMax = getOpenAIMaxOutputTokens(model)
  if (openaiMax !== undefined) {
    return { default: openaiMax, upperLimit: openaiMax }
  }

  const m = getCanonicalName(model)

  if (m.includes('opus-4-6')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-4-6')) {
    defaultTokens = 32_000
    upperLimit = 128_000
  } else if (
    m.includes('opus-4-5') ||
    m.includes('sonnet-4') ||
    m.includes('haiku-4')
  ) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else if (m.includes('opus-4-1') || m.includes('opus-4')) {
    defaultTokens = 32_000
    upperLimit = 32_000
  } else if (m.includes('claude-3-opus')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('claude-3-sonnet')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('claude-3-haiku')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('3-5-sonnet') || m.includes('3-5-haiku')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('3-7-sonnet')) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else {
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    defaultTokens = Math.min(defaultTokens, upperLimit)
  }

  return { default: defaultTokens, upperLimit }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
