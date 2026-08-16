/**
 * Generic per-model capability lookup.
 *
 * Aggregates the per-model capability data scattered across the runtime:
 *
 *   1. defineModel() registry (integrations/models/*.ts via
 *      integrations/index.ts → getAllModels()) — vendor model descriptors,
 *      covers contextWindow / maxOutputTokens / CapabilityFlags
 *      (supportsVision / supportsStreaming / etc.).
 *   2. OPENAI_CONTEXT_WINDOWS / OPENAI_MAX_OUTPUT_TOKENS tables
 *      (utils/model/openaiContextWindows.ts) — broad coverage of legacy
 *      aliases ("MiniMax-M3", "gpt-4o", "claude-*", "deepseek-v4-flash",
 *      etc.) with prefix + date-suffix tolerance.
 *   3. COPILOT_MODELS (utils/model/copilotModels.ts) — github-copilot
 *      route catalogue, exposes `attachment → supportsVision`,
 *      `tool_call → supportsFunctionCalling`, `reasoning → supportsReasoning`.
 *
 * Each source contributes the fields it knows about; missing fields fall
 * through to the next source. The returned shape mirrors zai's
 * `ModelCapabilities` (shared/settings.ts) so callers can spread-merge
 * directly: `{ ...generic, ...userCaps }`.
 *
 * Used by:
 *   - zai's profile → ModelEntry projection (routes/agentSettings.ts).
 *     When a user-saved provider profile omits `capabilities`, the UI
 *     ends up with no `contextWindow` and "上下文大小" renders as `— / —`.
 *     This module is the fallback that fills the gap from the integrated
 *     knowledge already in the runtime — without forcing every user to
 *     hand-fill capabilities for every model in `~/.zai.json`.
 *
 * Return undefined when no source has any data for the model. Callers
 * should treat undefined as "we don't know" and render `—` rather than
 * guessing.
 */

// Note on test loading: unit tests under packages/zn-agent-core/test/
// import the compiled bundle at `dist/opencc-src/utils/model/
// genericModelCapabilities.js`, not this source. The bundle has the
// registry + openai tables + copilot table all inlined by esbuild,
// which sidesteps vitest's stub-alias routing of relative imports of
// `../../integrations/...` (see vitest.config.ts → RELATIVE_RE).
//
// At runtime the bundle is what zai-server loads via the package
// subpath `@zn-ai/zn-agent-core/opencc-src/utils/model/genericModelCapabilities`,
// so test and runtime paths exercise the same compiled code.

// Register the integration descriptors (vendor / brand / gateway / model)
// the first time this module is imported. `integrations/index.ts` runs
// `ensureIntegrationsLoaded()` at module load — we import it lazily on
// first lookup so callers don't have to remember to wire it up.
import {
  getAllModels,
  getModel as getDescriptor,
} from '../../integrations/registry.js'
import { getOpenAIContextWindow, getOpenAIMaxOutputTokens } from './openaiContextWindows.js'
import { getCopilotModel } from './copilotModels.js'
import { ensureIntegrationsLoaded } from '../../integrations/index.js'

let bootstrapped = false
function bootstrapOnce(): void {
  if (bootstrapped) return
  bootstrapped = true
  try {
    ensureIntegrationsLoaded()
  } catch {
    // Bootstrap may throw in environments where the generated
    // integration artifacts aren't wired up (e.g. partial stub
    // environments). Swallow so lookup still returns whatever the
    // openai / copilot tables can resolve.
  }
}

/**
 * Per-model capability shape, matching zai's `ModelCapabilities` field-for-field.
 * All fields are optional — any subset may be filled depending on which
 * upstream data sources recognise the model name.
 */
export interface GenericModelCapabilities {
  contextWindow?: number
  maxOutputTokens?: number
  supportsVision?: boolean
  supportsFunctionCalling?: boolean
  supportsReasoning?: boolean
  supportsJsonMode?: boolean
  supportsStreaming?: boolean
}

/**
 * Look up generic capabilities for a model name.
 *
 * Empty / undefined input returns undefined without throwing — callers
 * pass model strings derived from user-controlled profile data and we
 * don't want a stray whitespace to crash a request.
 *
 * Lookup is case-sensitive at every layer (mirrors `defineModel` id
 * conventions and the openaiContextWindows static tables). Prefix /
 * date-suffix tolerance is delegated to `getOpenAIContextWindow` /
 * `getOpenAIMaxOutputTokens`, which already implement it via their
 * internal `lookupByKey`.
 */
export function lookupGenericModelCapabilities(
  model: string | undefined,
): GenericModelCapabilities | undefined {
  if (!model) return undefined
  const trimmed = model.trim()
  if (!trimmed) return undefined

  bootstrapOnce()

  const result: GenericModelCapabilities = {}
  let found = false

  // 1. defineModel() registry — vendor model descriptors. Most authoritative
  //    for vendor-native models because the descriptor is the canonical
  //    source of truth (no per-environment overrides, no prefix indirection).
  const descriptor =
    getDescriptor(trimmed) ??
    // Case-insensitive fallback: descriptor ids are case-sensitive but
    // OPENAI_CONTEXT_WINDOWS deliberately lists both casings (e.g.
    // 'MiniMax-M3' / 'minimax-m3' both present), so we should match either.
    findDescriptorCaseInsensitive(trimmed)
  if (descriptor) {
    found = true
    if (descriptor.contextWindow !== undefined) {
      result.contextWindow = descriptor.contextWindow
    }
    if (descriptor.maxOutputTokens !== undefined) {
      result.maxOutputTokens = descriptor.maxOutputTokens
    }
    const caps = descriptor.capabilities
    if (caps.supportsVision !== undefined) result.supportsVision = caps.supportsVision
    if (caps.supportsStreaming !== undefined) result.supportsStreaming = caps.supportsStreaming
    if (caps.supportsFunctionCalling !== undefined) {
      result.supportsFunctionCalling = caps.supportsFunctionCalling
    }
    if (caps.supportsReasoning !== undefined) result.supportsReasoning = caps.supportsReasoning
    if (caps.supportsJsonMode !== undefined) result.supportsJsonMode = caps.supportsJsonMode
  }

  // 2. openaiContextWindows static tables — broad coverage of legacy
  //    aliases (e.g. 'MiniMax-M3', 'gpt-4o', 'deepseek-v4-flash'). The
  //    underlying lookupByKey does prefix + date-suffix matching.
  const ctxWindow = getOpenAIContextWindow(trimmed)
  if (ctxWindow !== undefined) {
    found = true
    if (result.contextWindow === undefined) result.contextWindow = ctxWindow
  }
  const maxOut = getOpenAIMaxOutputTokens(trimmed)
  if (maxOut !== undefined) {
    found = true
    if (result.maxOutputTokens === undefined) result.maxOutputTokens = maxOut
  }

  // 3. COPILOT_MODELS — github-copilot route catalogue. Only namespace
  //    entries that explicitly exist here; we don't synthesise copilot
  //    capabilities for bare model names because the table keys are
  //    pinned to specific endpoint routes (gpt-4o on copilot ≠ bare
  //    gpt-4o on OpenAI).
  const copilot = getCopilotModel(trimmed)
  if (copilot) {
    found = true
    if (result.contextWindow === undefined) result.contextWindow = copilot.limit.context
    if (result.maxOutputTokens === undefined) result.maxOutputTokens = copilot.limit.output
    if (result.supportsVision === undefined) result.supportsVision = copilot.attachment
    if (result.supportsFunctionCalling === undefined) {
      result.supportsFunctionCalling = copilot.tool_call
    }
    if (result.supportsReasoning === undefined) result.supportsReasoning = copilot.reasoning
  }

  return found ? result : undefined
}

/**
 * Case-insensitive scan over the descriptor registry. `getModel(id)`
 * is case-sensitive (Map.get), but `OPENAI_CONTEXT_WINDOWS` deliberately
 * lists both casings — to stay consistent we accept either. Cost is
 * O(n) over the registry but the registry is small (~100 models) and
 * this only runs on profile projection / UI lookup paths, not request hot path.
 */
function findDescriptorCaseInsensitive(model: string) {
  const lower = model.toLowerCase()
  return getAllModels().find(m => m.id.toLowerCase() === lower)
}
