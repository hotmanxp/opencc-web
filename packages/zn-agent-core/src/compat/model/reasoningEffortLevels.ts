/**
 * zai patch (2026-09-28): per-model reasoning effort levels, resolved from
 * the vendor integration catalog.
 *
 * Why this exists instead of reusing `utils/effort.ts::getAvailableEffortLevels`:
 * the two answer different questions with different vocabularies.
 *
 *   - `getAvailableEffortLevels(model)` returns opencc's *internal UI*
 *     vocabulary (`EffortLevel` = low/medium/high/max/ultracode). It collapses
 *     the OpenAI-shaped `xhigh` into `max` and adds `ultracode`, which is a
 *     session-scoped orchestration mode, not an API level.
 *   - What actually goes on the wire is `ReasoningEffortLevel`
 *     (integrations/descriptors.ts) = low/medium/high/xhigh/max, declared
 *     per catalog entry as `reasoning: { mode: 'levels', levels, ... }`.
 *
 * MiniMax-M3.1-Flash-Preview is exactly where this bites: the zn-nova catalog
 * (gateways/zn-nova.ts) declares five levels — low/medium/high/xhigh/max,
 * default max — and MiniMax's docs advertise the same set. The internal
 * vocabulary can express only four of them distinctly, and would have us send
 * `max` where the vendor expects `xhigh`.
 *
 * Deliberately does NOT import `utils/effort.ts`: that module pulls in
 * settings / auth / analytics (growthbook), which the headless zai server
 * does not initialise. The integrations registry has no such dependency.
 */
import { getAllGateways, getCatalogForGateway } from '../../opencc-src/integrations/index.js'
import type {
  ModelCatalogEntry,
  ReasoningEffortLevel,
} from '../../opencc-src/integrations/descriptors.js'

export type { ReasoningEffortLevel }

function entryMatchesModel(entry: ModelCatalogEntry, needle: string): boolean {
  if (entry.apiName.toLowerCase() === needle) return true
  return (entry.aliases ?? []).some((a) => a.toLowerCase() === needle)
}

/**
 * Wire levels a model accepts, per the integration catalog, with a fallback
 * for models whose catalog entry declares no `reasoning.levels`.
 *
 * Contract: the caller must have already established that the model supports
 * reasoning at all (zai's model picker gates on `capabilities.supportsReasoning`
 * before calling). Given that, this answers "which levels", not "does it".
 * Models with no reasoning support must not reach here.
 *
 * Resolution order:
 *   1. The catalog entry's `reasoning.levels` — authoritative, and the only
 *      source for five-tier models (MiniMax-M3.1-Flash-Preview).
 *   2. A mirror of `utils/effort.ts`'s model-family rules, for catalog entries
 *      that predate the `reasoning` spec and simply omit it.
 *
 * The step-2 mirror is deliberately small and points at its source: if
 * `utils/effort.ts` changes its families, this is the place to follow. It is
 * not a general-purpose reimplementation — in particular it does NOT reproduce
 * `ultracode` (a session-scoped orchestration mode, not a wire level).
 *
 * Returns `[]` only when the model is absent from the catalog AND matches no
 * known family; callers treat that as "no opinion", which is not the same as
 * "no levels are supported".
 *
 * First catalog match wins rather than unioning across gateways: gateway
 * order is deterministic, and unioning would offer a level that one specific
 * route may reject. Over-offering produces a 400; under-offering is a
 * missing button.
 */
export function getReasoningEffortLevelsForModel(
  model: string | undefined,
): ReasoningEffortLevel[] {
  if (!model) return []
  const needle = model.trim().toLowerCase()
  if (!needle) return []

  for (const gateway of getAllGateways()) {
    const catalog = getCatalogForGateway(gateway.id)
    for (const entry of catalog?.models ?? []) {
      if (!entryMatchesModel(entry, needle)) continue
      const spec = entry.reasoning
      if (spec?.mode === 'levels' && spec.levels?.length) {
        return [...spec.levels]
      }
    }
  }
  return fallbackEffortLevels(needle)
}

/**
 * Family rules mirrored from `utils/effort.ts`.
 *
 * - GLM on Z.AI (`supportsZaiReasoningEffort`) accepts only low/high/max —
 *   the gateway maps reasoning_effort straight through to OpenAI, which has no
 *   `medium`. Offering it is a guaranteed 400:
 *   "'reasoning_effort' must be one of: 'low', 'high', 'max'".
 * - The MiniMax M3 family reaches `max` (`modelSupportsMaxEffort`), but not
 *   `xhigh` — that fifth tier is specific to M3.1-Flash-Preview and is
 *   declared by its catalog entry above.
 * - Everything else: the three classic levels.
 */
function fallbackEffortLevels(needle: string): ReasoningEffortLevel[] {
  if (
    needle === 'glm-5.2'
    || needle === 'zai-org/glm-5.2'
    || needle === 'glm-5.3'
    || needle === 'zai-org/glm-5.3'
    || needle === 'zhiniao-glm-5.1'
    || needle.endsWith('/glm-5.2')
    || needle.endsWith('/glm-5.3')
  ) {
    return ['low', 'high', 'max']
  }
  if (needle.includes('minimax-m3')) {
    return ['low', 'medium', 'high', 'max']
  }
  return ['low', 'medium', 'high']
}

/**
 * The catalog's declared default level for a model, or undefined when the
 * catalog has no opinion. The model still decides the wire value when none is
 * set (MiniMax-M3.1-Flash-Preview falls back to the API-side default).
 */
export function getDefaultReasoningEffortLevelForModel(
  model: string | undefined,
): ReasoningEffortLevel | undefined {
  if (!model) return undefined
  const needle = model.trim().toLowerCase()
  if (!needle) return undefined

  for (const gateway of getAllGateways()) {
    const catalog = getCatalogForGateway(gateway.id)
    for (const entry of catalog?.models ?? []) {
      if (!entryMatchesModel(entry, needle)) continue
      return entry.reasoning?.defaultLevel
    }
  }
  return undefined
}
