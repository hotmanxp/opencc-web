// @ts-nocheck
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { type Providers } from '../config.js'
import { isEnvTruthy } from '../envUtils.js'
import { getGlobalConfig } from '../config.js'
import { getActiveProviderProfile } from '../providerProfiles.js'

export type APIProvider = 'firstParty' | Providers | 'hicap'

/** @deprecated Use APIProvider — kept as alias for `updateStrategy.ts` and any
 * upstream-cherry-picked callers still importing the pre-rebrand name. */
export type LegacyAPIProvider = APIProvider

/**
 * Legacy / fork-removed provider env vars that route to a non-Anthropic
 * model family. Listed here so `getAPIProvider()` can short-circuit them
 * out of the 'firstParty' branch (they would otherwise hit the default
 * firstParty branch and silently enable Anthropic-specific behavior —
 * beta headers, account-flow, etc).
 *
 * Per OpenCC AGENTS.md, only three providers are supported: anthropic,
 * ollama, openai-compatible. The legacy vars exist in the codebase
 * (CLAUDE_CODE_USE_BEDROCK / USE_VERTEX / USE_FOUNDRY / USE_GITHUB)
 * but are deliberately routed to 'firstParty' or 'openai' depending on
 * whether the underlying transport is Anthropic-native or OpenAI-shaped.
 */
const NON_FIRST_PARTY_ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  // GitHub Copilot is OpenAI-shaped by default; the "native Claude"
  // exception is a per-model gate in isGithubNativeAnthropicMode, but
  // getAPIProvider has no model context, so we conservatively route
  // GitHub to 'openai' here and let the caller (betas.ts) re-promote
  // it to first-party when the model is a Claude model.
  'CLAUDE_CODE_USE_GITHUB',
  // 3P API keys (provider is the API surface, not Anthropic even if
  // the model name happens to be "claude-*" on X.AI / minimax et al).
  'XAI_API_KEY',
  'MINIMAX_API_KEY',
] as const

export function getAPIProvider(): APIProvider {
  // First check providerProfiles config from ~/.claude.json
  const globalConfig = getGlobalConfig()
  const activeProfile = getActiveProviderProfile(globalConfig)
  if (activeProfile) {
    return activeProfile.provider === 'anthropic' ? 'firstParty' : activeProfile.provider
  }

  // Fall back to explicit env flag
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) {
    return 'openai'
  }
  return 'firstParty'
}

const API_KEY_ENV_KEYS = new Set([
  'XAI_API_KEY',
  'MINIMAX_API_KEY',
])

function is3PApiKey(key: string): boolean {
  return API_KEY_ENV_KEYS.has(key)
}

export function usesAnthropicAccountFlow(): boolean {
  return getAPIProvider() === 'firstParty'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}

/**
 * GitHub Copilot has a special native-Claude path for Claude models:
 * when CLAUDE_CODE_USE_GITHUB=1 is set AND the active model is a Claude
 * model, the runtime routes through the native Anthropic path (not the
 * OpenAI shim) to enable prompt caching. This is the gate that the
 * beta-header logic in `betas.ts` consults to decide whether to send
 * Anthropic-specific headers on a GitHub-Copilot-shaped request.
 *
 * Returns true only when BOTH conditions hold; any other combination
 * (github env unset, OR non-Claude model on the github provider) returns
 * false so beta headers are correctly stripped.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md
 * @see src/integrations/gateways/github.ts
 */
export function isGithubNativeAnthropicMode(model?: string): boolean {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB)) return false
  if (!model) return false
  return model.toLowerCase().includes('claude')
}
