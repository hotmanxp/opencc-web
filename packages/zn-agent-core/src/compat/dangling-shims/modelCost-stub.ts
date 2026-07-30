/**
 * Stub for opencc-src/utils/modelCost.ts.
 *
 * Why this exists:
 *   The vendored opencc has a circular import between
 *   `utils/model/model.ts` and `utils/modelCost.ts`:
 *     - model.ts line 23:  `import { formatModelPricing, getOpus46CostTier } from '../modelCost.ts'`
 *     - modelCost.ts line 20-25: `import { firstPartyNameToCanonical, ... } from './model/model.ts'`
 *
 *   modelCost.ts's TOP-LEVEL `MODEL_COSTS` object literal (line 105-129)
 *   uses `firstPartyNameToCanonical(...)` as COMPUTED PROPERTY KEYS,
 *   which are evaluated eagerly. Under Node ESM, the cycle breaks:
 *     1. model.ts loads, hits `import '../modelCost.ts'`
 *     2. modelCost.ts loads, hits `import './model/model.ts'` → model.ts
 *        is still evaluating, so the import binding is `undefined`
 *     3. modelCost.ts evaluates line 106: `firstPartyNameToCanonical(...)`
 *        → throws "undefined is not a function"
 *
 *   This stub breaks the cycle: it doesn't import from model.ts. All
 *   cost values are hardcoded with canonical model name strings
 *   (instead of computed keys via `firstPartyNameToCanonical`), so
 *   no top-level evaluation depends on model.ts.
 *
 * Trade-off:
 *   - We lose the auto-mapping from opencc config `firstParty` strings
 *     (e.g. `'claude-3-5-haiku-20241022'`) to canonical short names.
 *     zai uses its own settings loader + modelCaller, so cost data is
 *     mostly informational (telemetry). For the bridge path
 *     (`runViaOpenccQuery`), no cost data is read at runtime — query()
 *     runs the agent loop and streams SDKMessages; costs are computed
 *     post-hoc for analytics.
 *   - If zai ever needs real cost data, delete this stub and patch
 *     the cycle at vendoring time (see copy-from-opencc.ts).
 *
 * Wired via vitest.config.ts + bun-protocol.mjs aliases:
 *   { find: /opencc-src\/utils\/modelCost(\.ts|\.js)?$/,
 *     replacement: '...dangling-shims/modelCost-stub.ts' }
 */

type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

export type { ModelCosts }

// Cost tier constants — verbatim from opencc-src/utils/modelCost.ts
export const COST_TIER_3_15 = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_TIER_15_75 = {
  inputTokens: 15,
  outputTokens: 75,
  promptCacheWriteTokens: 18.75,
  promptCacheReadTokens: 1.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_TIER_5_25 = {
  inputTokens: 5,
  outputTokens: 25,
  promptCacheWriteTokens: 6.25,
  promptCacheReadTokens: 0.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_TIER_30_150 = {
  inputTokens: 30,
  outputTokens: 150,
  promptCacheWriteTokens: 37.5,
  promptCacheReadTokens: 3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_HAIKU_35 = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheReadTokens: 0.08,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_HAIKU_45 = {
  inputTokens: 1,
  outputTokens: 5,
  promptCacheWriteTokens: 1.25,
  promptCacheReadTokens: 0.1,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

const DEFAULT_UNKNOWN_MODEL_COST = COST_TIER_5_25

/**
 * Hardcoded canonical-name → cost mapping. Mirrors MODEL_COSTS from
 * opencc vendor, but with string keys (no `firstPartyNameToCanonical`
 * computation). The canonical names match the values `firstPartyNameToCanonical`
 * returns for the corresponding CLAUDE_*_CONFIG.firstParty strings.
 */
export const MODEL_COSTS: Record<string, ModelCosts> = {
  'claude-3-5-haiku': COST_HAIKU_35,
  'claude-haiku-4-5': COST_HAIKU_45,
  'claude-3-5-sonnet': COST_TIER_3_15,
  'claude-3-7-sonnet': COST_TIER_3_15,
  'claude-sonnet-4': COST_TIER_3_15,
  'claude-sonnet-4-5': COST_TIER_3_15,
  'claude-sonnet-4-6': COST_TIER_3_15,
  'claude-opus-4': COST_TIER_15_75,
  'claude-opus-4-1': COST_TIER_15_75,
  'claude-opus-4-5': COST_TIER_5_25,
  'claude-opus-4-6': COST_TIER_5_25,
  'claude-opus-4-7': COST_TIER_5_25,
}

export function getOpus46CostTier(fastMode: boolean): ModelCosts {
  if (fastMode) return COST_TIER_30_150
  return COST_TIER_5_25
}

/**
 * Minimal stand-in for `firstPartyNameToCanonical` — used by callers
 * other than modelCost.ts (e.g. analytics) that may import this name
 * from the same module via re-export. The vendor exports it via
 * model.ts, not modelCost.ts, so this is defensive only.
 */
export function firstPartyNameToCanonical(name: string): string {
  name = name.toLowerCase()
  if (name.includes('claude-opus-4-6')) return 'claude-opus-4-6'
  if (name.includes('claude-opus-4-5')) return 'claude-opus-4-5'
  if (name.includes('claude-opus-4-1')) return 'claude-opus-4-1'
  if (name.includes('claude-opus-4-7')) return 'claude-opus-4-7'
  if (name.includes('claude-opus-4')) return 'claude-opus-4'
  if (name.includes('claude-sonnet-4-6')) return 'claude-sonnet-4-6'
  if (name.includes('claude-sonnet-4-5')) return 'claude-sonnet-4-5'
  if (name.includes('claude-sonnet-4')) return 'claude-sonnet-4'
  if (name.includes('claude-haiku-4-5')) return 'claude-haiku-4-5'
  if (name.includes('claude-3-7-sonnet')) return 'claude-3-7-sonnet'
  if (name.includes('claude-3-5-haiku')) return 'claude-3-5-haiku'
  if (name.includes('claude-3-5-sonnet')) return 'claude-3-5-sonnet'
  return name
}

export function getCanonicalName(model: string): string {
  // Strip everything after the first colon (bedrock ARNs etc.)
  const colonless = model.split(':')[0]
  // Try canonical first
  const canonical = firstPartyNameToCanonical(colonless)
  if (MODEL_COSTS[canonical]) return canonical
  return colonless
}

export function getDefaultMainLoopModelSetting(): string {
  return 'claude-sonnet-4-5'
}

export function getModelCosts(model: string, _usage?: unknown): ModelCosts {
  const shortName = getCanonicalName(model)
  const costs = MODEL_COSTS[shortName]
  if (!costs) return DEFAULT_UNKNOWN_MODEL_COST
  return costs
}

export function calculateUSDCost(resolvedModel: string, usage: unknown): number {
  return calculateCostFromTokens(resolvedModel, usage)
}

export function calculateCostFromTokens(resolvedModel: string, usage: any): number {
  const costs = getModelCosts(resolvedModel, usage)
  if (!costs) return 0
  return (
    ((usage?.input_tokens ?? 0) / 1_000_000) * costs.inputTokens +
    ((usage?.output_tokens ?? 0) / 1_000_000) * costs.outputTokens +
    ((usage?.cache_read_input_tokens ?? 0) / 1_000_000) *
      costs.promptCacheReadTokens +
    ((usage?.cache_creation_input_tokens ?? 0) / 1_000_000) *
      costs.promptCacheWriteTokens +
    (usage?.server_tool_use?.web_search_requests ?? 0) *
      costs.webSearchRequests
  )
}

export function formatModelPricing(costs: ModelCosts): string {
  return `$${costs.inputTokens}/$${costs.outputTokens} per Mtok`
}

export function getModelPricingString(model: string): string | undefined {
  const costs = MODEL_COSTS[getCanonicalName(model)]
  return costs ? formatModelPricing(costs) : undefined
}