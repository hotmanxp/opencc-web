import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getCachedZaiSettingsSync } from '../services/zaiSettingsStore.js'

export interface ResolveModelInput {
  /** transcript.meta.model — 'unknown' / null / undefined all mean "not specified". */
  sessionModel: string | null | undefined
  /** transcript.meta.providerId — the provider profile the user picked
   *  for this session. Threads through to modelCaller.findProfileForModel
   *  so a model name that exists on multiple provider profiles routes
   *  to the one the user actually selected. Optional. */
  sessionProviderId?: string | null
  /** Reserved for future cwd-scoped overrides; v1 ignores this. */
  cwd: string
}

export interface ResolveModelResult {
  /** Resolved model ID. Never null/empty. */
  model: string
  source:
    | 'session'
    | 'env_default_sonnet'
    | 'env_small_fast'
    | 'settings_model'
    | 'builtin_fallback'
  /** Original alias if model mapping was applied. */
  mappedFrom?: string
  /**
   * Provider profile id forwarded from the session, when `source` is
   * `'session'`. The modelCaller consults it as the preferred id when
   * `findProfileForModel` has multiple candidates with the same model
   * name. Undefined for env/settings/builtin_fallback layers — those
   * paths have no associated provider id yet (see plan §阶段 3
   * resolveModel note).
   */
  providerId?: string
}

/** Final fallback when nothing else resolves. Used by tests + non-/agent/prompt callers. */
export const BUILTIN_FALLBACK_MODEL = 'MiniMax-M3'

// ---------------------------------------------------------------------------
// Model Mapping: alias → concrete model ID, per-provider
// ---------------------------------------------------------------------------

export type ProviderType = 'anthropic' | 'openai' | string

const PROVIDER_MODEL_MAPPINGS: Record<ProviderType, Record<string, string>> = {
  anthropic: {
    haiku: 'MiniMax-M2.7-highspeed',
    sonnet: 'MiniMax-M3',
    opus: 'glm-5.2',
  },
  openai: {
    haiku: 'zhiniao-MiniMax-M2.7-highspeed',
    sonnet: 'zhiniao-MiniMax-M2.7',
    opus: 'zhiniao-glm-5.1',
  },
}

/**
 * Determine the current provider from ~/.zai.json providerProfiles.
 * Takes the first profile's `provider` field. Defaults to 'anthropic'.
 */
export function resolveCurrentProvider(): ProviderType {
  try {
    const path = join(homedir(), '.zai.json')
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    const profiles = Array.isArray(raw?.providerProfiles) ? raw.providerProfiles : []
    if (profiles.length > 0 && profiles[0]?.provider) {
      return profiles[0].provider
    }
  } catch {
    // File missing or malformed — fall through to default
  }
  return 'anthropic'
}

/**
 * Parse ZAI_MODEL_MAPPING env var.
 * Format: "haiku=model-a,sonnet=model-b,opus=model-c"
 * Empty value disables mapping for that key.
 * Malformed entries (missing '=') are ignored.
 */
export function parseModelMappingEnv(envValue: string | undefined): Record<string, string | null> {
  if (!envValue) return {}
  const overrides: Record<string, string | null> = {}
  for (const pair of envValue.split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue // malformed, skip
    const key = trimmed.slice(0, eqIdx).trim().toLowerCase()
    const value = trimmed.slice(eqIdx + 1).trim()
    overrides[key] = value === '' ? null : value
  }
  return overrides
}

/**
 * Apply model mapping: if the resolved model matches an alias key,
 * replace it with the mapped concrete model ID based on the current provider.
 *
 * Priority: env override > provider-specific default > pass-through.
 */
export function applyModelMapping(
  model: string,
  opts?: { envMapping?: string; provider?: ProviderType },
): { model: string; mappedFrom?: string } {
  const overrides = parseModelMappingEnv(opts?.envMapping ?? process.env.ZAI_MODEL_MAPPING)
  const provider = opts?.provider ?? resolveCurrentProvider()
  const key = model.toLowerCase()

  // Check if mapping is explicitly disabled for this key
  if (key in overrides && overrides[key] === null) {
    return { model }
  }

  // Env override takes highest priority
  if (key in overrides && overrides[key] !== null) {
    return { model: overrides[key]!, mappedFrom: model }
  }

  // Provider-specific default mapping
  const providerMapping = PROVIDER_MODEL_MAPPINGS[provider]
  if (providerMapping && key in providerMapping) {
    return { model: providerMapping[key], mappedFrom: model }
  }

  // Pass-through: not a known alias for this provider
  return { model }
}

/**
 * Resolve the effective model for a single turn.
 *
 * Layer order (see spec):
 *   1. sessionModel (if not 'unknown' / empty) — also carries sessionProviderId
 *   2. env.ANTHROPIC_DEFAULT_SONNET_MODEL
 *   3. env.ANTHROPIC_SMALL_FAST_MODEL
 *   4. settings.model
 *   5. BUILTIN_FALLBACK_MODEL
 *   6. Model mapping (alias → concrete ID, per-provider)
 *
 * Always returns a non-empty `model`. The `source` field lets the caller
 * log which layer won. `providerId` is only populated when `source` is
 * `'session'` — env/settings/builtin fallback layers don't track a
 * provider id yet, so the matcher falls back to first-match-by-name.
 */
export function resolveModel(input: ResolveModelInput): ResolveModelResult {
  let result: ResolveModelResult

  if (input.sessionModel && input.sessionModel !== 'unknown') {
    result = {
      model: input.sessionModel,
      source: 'session',
      // Only forward providerId when it's a non-empty string — null /
      // undefined / '' should not show up as a "preference" to the
      // matcher (the matcher treats undefined as "no preference").
      ...(typeof input.sessionProviderId === 'string' && input.sessionProviderId.length > 0
        ? { providerId: input.sessionProviderId }
        : {}),
    }
  } else {
    const settings = getCachedZaiSettingsSync()
    const env = settings.env ?? {}
    if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
      result = { model: env.ANTHROPIC_DEFAULT_SONNET_MODEL, source: 'env_default_sonnet' }
    } else if (env.ANTHROPIC_SMALL_FAST_MODEL) {
      result = { model: env.ANTHROPIC_SMALL_FAST_MODEL, source: 'env_small_fast' }
    } else if (settings.model) {
      result = { model: settings.model, source: 'settings_model' }
    } else {
      result = { model: BUILTIN_FALLBACK_MODEL, source: 'builtin_fallback' }
    }
  }

  // Apply model mapping as the final step (provider-aware). Note: alias
  // mapping (haiku/sonnet/opus) resolves the alias against the CURRENT
  // provider (read from ~/.zai.json's first profile), which can flip
  // the model name to a different provider's model. The providerId
  // forwarded above is the one the user explicitly picked — we keep it
  // as-is even after alias mapping; the matcher will retry against
  // profiles when the alias resolves to a different model id.
  const mapped = applyModelMapping(result.model)
  return { ...result, model: mapped.model, mappedFrom: mapped.mappedFrom }
}
