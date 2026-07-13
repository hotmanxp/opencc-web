import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
}

/** Final fallback when nothing else resolves. Used by tests + non-/agent/prompt callers. */
export const BUILTIN_FALLBACK_MODEL = 'MiniMax-M3'

/**
 * Read ~/.zai/settings.json. Returns parsed object or empty object on
 * missing/invalid JSON. Real IO errors are re-thrown for the route's
 * 500 path. Mirrors the same defensive pattern used in
 * src/server/routes/agentSettings.ts:21-29.
 */
function readZaiSettings(): {
  env?: Record<string, string>
  model?: string
} {
  try {
    const p = join(homedir(), '.zai', 'settings.json')
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch (err) {
    if (err instanceof SyntaxError) return {}
    throw err
  }
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
 *
 * Always returns a non-empty `model`. The `source` field lets the caller
 * log which layer won.
 */
export function resolveModel(input: ResolveModelInput): ResolveModelResult {
  if (input.sessionModel && input.sessionModel !== 'unknown') {
    return { model: input.sessionModel, source: 'session' }
  }
  const settings = readZaiSettings()
  const env = settings.env ?? {}
  if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return { model: env.ANTHROPIC_DEFAULT_SONNET_MODEL, source: 'env_default_sonnet' }
  }
  if (env.ANTHROPIC_SMALL_FAST_MODEL) {
    return { model: env.ANTHROPIC_SMALL_FAST_MODEL, source: 'env_small_fast' }
  }
  if (settings.model) {
    return { model: settings.model, source: 'settings_model' }
  }
  return { model: BUILTIN_FALLBACK_MODEL, source: 'builtin_fallback' }
}