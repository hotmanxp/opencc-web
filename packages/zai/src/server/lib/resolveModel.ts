import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getCachedZaiSettingsSync } from '../services/zaiSettingsStore.js'

export interface ResolveModelInput {
  /** transcript.meta.model — 'unknown' / null / undefined all mean "not specified". */
  sessionModel: string | null | undefined
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
 * Determine the current provider from ~/.claude.json providerProfiles.
 * Takes the first profile's `provider` field. Defaults to 'anthropic'.
 */
export function resolveCurrentProvider(): ProviderType {
  try {
    const path = join(homedir(), '.claude.json')
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
 *   1. sessionModel (if not 'unknown' / empty)
 *   2. env.ANTHROPIC_DEFAULT_SONNET_MODEL
 *   3. env.ANTHROPIC_SMALL_FAST_MODEL
 *   4. settings.model
 *   5. BUILTIN_FALLBACK_MODEL
 *   6. Model mapping (alias → concrete ID, per-provider)
 *
 * Always returns a non-empty `model`. The `source` field lets the caller
 * log which layer won.
 */
export function resolveModel(input: ResolveModelInput): ResolveModelResult {
  let result: ResolveModelResult

  if (input.sessionModel && input.sessionModel !== 'unknown') {
    result = { model: input.sessionModel, source: 'session' }
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

  // Apply model mapping as the final step (provider-aware)
  const mapped = applyModelMapping(result.model)
  return { ...result, model: mapped.model, mappedFrom: mapped.mappedFrom }
}
