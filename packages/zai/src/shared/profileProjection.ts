/**
 * Helpers for projecting ProviderProfile records into the flat ModelEntry
 * shape consumed by the picker UI / conversation-info card.
 *
 * Lives in `shared/` (not `server/`) because both the HTTP route and the
 * unit tests under `packages/zai/test/server/routes/agentSettings.test.ts`
 * need to import it, and `shared/` is the conventional cross-layer seam.
 *
 * `mergeGenericCapabilities` is the user-facing contract change:
 * capabilities the user saved in `~/.zai.json → providerProfiles[].capabilities`
 * still win on every field they set, but fields they left undefined now
 * fall back to a generic lookup against the runtime's per-model knowledge
 * (defineModel registry + OPENAI_CONTEXT_WINDOWS + COPILOT_MODELS). This is
 * what surfaces `contextWindow` in the conversation-info card for
 * hand-written profiles — without the fallback the card renders `— / —`.
 */
import type { ModelEntry, ModelCapabilities } from './settings.js'
import type { ProviderProfile } from './types.js'
import { lookupGenericModelCapabilities } from '@zn-ai/zn-agent-core/opencc-src/utils/model/genericModelCapabilities'

/**
 * Project a list of provider profiles onto a flat ModelEntry table for
 * the picker. Each comma-separated model in profile.model becomes one
 * ModelEntry whose alias encodes the provider name (e.g. `nova-m3`).
 *
 * `providerId` is set from `profile.id` so the picker can preserve the
 * user-picked provider across the model → service roundtrip (the
 * server-side `findProfileForModel` uses it to disambiguate when
 * multiple profiles share the same model name).
 *
 * Capabilities are merged via `mergeGenericCapabilities` so a profile
 * with no `capabilities` field still surfaces `contextWindow` (and
 * other capability flags) when the model is known to the runtime.
 */
export function profilesToModelEntries(profiles: ProviderProfile[]): ModelEntry[] {
  const out: ModelEntry[] = []
  for (const p of profiles) {
    if (!p.model) continue
    const models = p.model.split(',').map((m) => m.trim()).filter(Boolean)
    // profile.id is the canonical namespace; older saved profiles may
    // lack it but the name is unique enough to disambiguate in the
    // picker when no id is present.
    const profileKey = p.id ?? slugifyProfileName(p.name)
    for (const model of models) {
      out.push({
        alias: `${profileKey}-${slugifyModelName(model)}`,
        model,
        label: model,
        description: p.name,
        baseUrl: p.baseUrl,
        capabilities: mergeGenericCapabilities(p.capabilities?.[model], model),
        // zai patch: thread providerId through to the picker so
        // ModelStatusButton.pickEntry can persist the user's choice
        // back to transcript.meta.providerId. Profiles without an id
        // (legacy configs) intentionally leave providerId undefined
        // — findProfileForModel falls back to legacy first-match
        // behavior when no preferred id is set.
        providerId: p.id,
      })
    }
  }
  return out
}

/**
 * Merge user-saved capabilities with the generic core lookup.
 *
 * Semantics — user wins on every present field, generic fills only
 * fields the user left undefined:
 *
 *   `{ ...generic, ...userCaps }`
 *
 * Three branches:
 *   - userCaps undefined, generic returns nothing → result undefined
 *     (model unknown to both layers; UI shows `—` for every cap).
 *   - userCaps undefined, generic returns something → result is
 *     `generic` copy. This is the "user-saved profile with no
 *     capabilities field" case the fallback was added for.
 *   - userCaps defined → spread-merge, generic fills holes.
 *
 * Builtin profiles (openplatformCaps / zhiniaoCaps) always pass a
 * non-empty `userCaps`, so the merge path is the third branch and
 * their explicit `supportsVision: false` (for example) survives the
 * generic layer — builtin data is treated as authoritative.
 */
export function mergeGenericCapabilities(
  userCaps: ModelCapabilities | undefined,
  model: string,
): ModelCapabilities | undefined {
  const generic = lookupGenericModelCapabilities(model) ?? {}
  if (!userCaps) {
    return Object.keys(generic).length > 0 ? { ...generic } : undefined
  }
  return { ...generic, ...userCaps }
}

function slugifyProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile'
}

function slugifyModelName(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model'
}
