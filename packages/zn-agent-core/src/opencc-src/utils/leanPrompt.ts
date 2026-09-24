import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getInitialSettings } from './settings/settings.js'
import { isEnvTruthy } from './envUtils.js'

/**
 * Whether to use the condensed "lean" system prompt.
 *
 * Upstream claude-code 2.1.280 replaces its six static system prompt sections
 * (`cVn`/`uVn`/`fVn`/`pVn`/`gVn`/`_Vn`) with a single `# Harness` section when
 * its per-model `leanPrompt` client-data flag is set. OpenCC has no client-data
 * channel, so the equivalent is resolved locally — all sources default to
 * false so nothing changes unless explicitly opted in.
 *
 * Precedence: env > settings > growthbook.
 */
export function isLeanSystemPrompt(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_LEAN_SYSTEM_PROMPT)) return true
  if (getInitialSettings().leanSystemPrompt === true) return true
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_lean_prompt', false)
}