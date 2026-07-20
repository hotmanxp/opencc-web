/**
 * runtime/summary/stepCounter.ts — agent step limit resolver.
 *
 * Spec: docs/superpowers/specs/2026-07-19-zai-loop-resilience-e-step-limit-design.md
 *
 * `getAgentStepLimit` resolves the maximum number of turns (steps) the agent
 * loop should run before forcing a summary message and breaking.
 *
 * Contract (§2.1, §2.4):
 *   - Pure function; never throws.
 *   - Priority: userOptIn > config > env (env parsed as integer).
 *   - `env.ZAI_DISABLE_AGENT_STEP_LIMIT='1'` → null (explicit disable; wins
 *     over config + userOptIn).
 *   - No config / env / userOptIn → null (no limit; behavior unchanged).
 *
 * This module is integration-tested but does NOT itself enforce the limit —
 * the integration PR (Phase 2) wires the result into queryLoop.ts:
 *
 *   const stepLimit = getAgentStepLimit({ config })
 *   if (stepLimit !== null && turn > stepLimit) break + force-summary
 *
 * `runtime.done` carrying `reason: 'step-limit-reached'` is also emitted by
 * the integration PR; this module does not produce that event itself.
 */

// ---- public types ----------------------------------------------------------

/**
 * Minimal RuntimeConfig slice this module needs. Kept narrow + structural so
 * unit tests can pass partial shapes and integration tests can pass the full
 * `RuntimeConfig` from `../types.js` without depending on it here (avoids
 * circular imports / coupling).
 */
export interface RuntimeConfigSlice {
  runtime?: {
    agentStepLimit?: number | undefined
    /** present to allow shared shape with `RuntimeConfig.runtime` */
    [key: string]: unknown
  }
  /** allow unknown siblings (dataDir, defaultModel, etc.) */
  [key: string]: unknown
}

export interface StepLimitOptions {
  config?: RuntimeConfigSlice | null | undefined
  /**
   * Environment variables to read. Defaults to `process.env` when omitted.
   * Keys consumed: `ZAI_AGENT_STEP_LIMIT`, `ZAI_DISABLE_AGENT_STEP_LIMIT`.
   */
  env?: Record<string, string | undefined> | null | undefined
  /** Per-query override; highest priority. */
  userOptIn?: number | undefined
}

// ---- env keys --------------------------------------------------------------

const ENV_STEP_LIMIT = 'ZAI_AGENT_STEP_LIMIT'
const ENV_DISABLE_STEP_LIMIT = 'ZAI_DISABLE_AGENT_STEP_LIMIT'

// ---- implementation --------------------------------------------------------

/**
 * Resolve the agent step limit per spec §2.1 + §2.4.
 *
 * @returns A positive (or zero) integer step limit, or `null` to indicate
 *          "no limit" (default behavior preserved).
 */
export function getAgentStepLimit(
  opts?: StepLimitOptions,
): number | null {
  const o = opts ?? {}

  // Resolve env source once. Tolerate null / undefined inputs.
  const env = (o.env ?? process.env) as Record<string, string | undefined>

  // Explicit disable wins over everything else (§3 行为 4).
  if (env[ENV_DISABLE_STEP_LIMIT] === '1') {
    return null
  }

  // userOptIn has highest priority (§3 行为 3).
  if (typeof o.userOptIn === 'number' && Number.isFinite(o.userOptIn)) {
    return o.userOptIn
  }

  // config.runtime.agentStepLimit next (§3 行为 1).
  const configLimit = readConfigLimit(o.config)
  if (configLimit !== undefined) {
    return configLimit
  }

  // env.ZAI_AGENT_STEP_LIMIT last (§3 行为 2). Parse strict integer.
  const envLimit = parseIntStrict(env[ENV_STEP_LIMIT])
  if (envLimit !== undefined) {
    return envLimit
  }

  return null
}

// ---- helpers ---------------------------------------------------------------

function readConfigLimit(config: RuntimeConfigSlice | null | undefined): number | undefined {
  if (!config || typeof config !== 'object') return undefined
  const runtime = (config as { runtime?: unknown }).runtime
  if (!runtime || typeof runtime !== 'object') return undefined
  const raw = (runtime as { agentStepLimit?: unknown }).agentStepLimit
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  return undefined
}

/**
 * Parse a string into a strict integer. Rejects floats, NaN, empty strings,
 * leading whitespace. Returns `undefined` for any non-integer input (caller
 * falls back to null / no-limit).
 *
 * Accepts negative integers so `ZAI_AGENT_STEP_LIMIT=-1` could be used as an
 * opt-out alternative to `ZAI_DISABLE_AGENT_STEP_LIMIT=1` (defensive — not in
 * spec, but trivial and harmless).
 */
function parseIntStrict(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  // /^-?\d+$/ rejects '1.5', '1e3', ' 1', '1 ', 'abc', etc.
  if (!/^-?\d+$/.test(trimmed)) return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return undefined
  return n
}
