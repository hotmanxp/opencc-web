// @ts-nocheck
import type { ModelAlias } from './aliases.js'

/**
 * Alias-tier overrides keyed by provider.
 *
 * Layered BEFORE the canonical alias → first-party/OpenAI-default resolution
 * so a downstream `parseUserSpecifiedModel('opus')` returns the mapped target
 * instead of `claude-opus-4-6` / `gpt-4o`. Keeps ANTHROPIC_DEFAULT_*_MODEL,
 * settings.model, legacy remap, and ant resolve paths untouched.
 *
 * Shape kept intentionally narrow (3 tiers × 2 providers); the OpenCC provider
 * policy restricts supported providers to anthropic / ollama / openai-compatible,
 * so the table does not extend to bedrock/vertex/codex/etc.
 */
export type AliasOverrideProvider = 'firstParty' | 'openai'

export type AliasOverrideTier = Extract<ModelAlias, 'opus' | 'sonnet' | 'haiku'>

export const PROVIDER_ALIAS_OVERRIDES: Readonly<
  Record<AliasOverrideProvider, Record<AliasOverrideTier, string>>
> = {
  firstParty: {
    opus: 'glm-5.2',
    sonnet: 'MiniMax-M3',
    haiku: 'MiniMax-M2.7-highspeed',
  },
  openai: {
    opus: 'zhiniao-glm-5.1',
    sonnet: 'zhiniao-MiniMax-M2.7',
    haiku: 'zhiniao-MiniMax-M2.7-highspeed',
  },
}

/**
 * Look up an alias-tier override for the given provider.
 * Returns undefined when the alias has no entry for the provider — caller
 * should fall through to the standard alias resolution path.
 */
export function lookupAliasOverride(
  provider: AliasOverrideProvider,
  alias: AliasOverrideTier,
): string | undefined {
  return PROVIDER_ALIAS_OVERRIDES[provider]?.[alias]
}