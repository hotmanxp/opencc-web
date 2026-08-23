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
import { lookupGenericModelCapabilities } from '@zn-ai/zn-agent-core'

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
        // ds-022 effort-picker follow-up:reasoning effort levels the
        // model supports. zai-side 内置 miniMax 系列 lookup;其它
        // 模型留空 → picker 不渲染(保守,等 vendor 接 explicit
        // 支持后再扩)。
        reasoningLevels: lookupReasoningLevels(model),
      })
    }
  }
  return out
}

/**
 * 内置 per-model `reasoningEffort` levels — ds-022 effort-picker 用。
 *
 * 单一事实源:zai-side web picker 渲染 + dsh adapter `validateReasoningEffort`
 * 双边一致。如果 dsh-bridge 后面提供 vendor-level source(类似
 * `loadAvailableModels`),这里改成 thin wrapper 即可。
 *
 * 已知 vendor naming 不一致:
 *   - DeepSeek / Anthropic: 'low' / 'medium' / 'high'
 *   - OpenAI Codex: 'minimal' / 'low' / 'medium' / 'high' / 'xhigh' (含 'max' 别名)
 *   - zai-side Anthropic 走 minimax 网关,与 dsh adapter 同一组,
 *     所以本页只列 `'low'/'medium'/'high'`,OpenAI-via-zai 走 OpenCC
 *     vendor `OpenccQueryInput.effort` 本工厂不接(ds-023 follow-up)。
 */
const MODEL_REASONING_LEVELS: Record<string, string[]> = {
  // reasoning-capable miniMax 系列 — 与 dsh.ts `anthropicProfile.models[]`
  // 的 `reasoningEfforts` 字段对齐。dsh 模式的真源是 anthropicProfile;
  // 这里只走 web picker 渲染,server adapter 的 `validateReasoningEffort`
  // 仍会校验 user-effort 是否在 anthropicProfile 列表内 — 一处错会
  // 双重防护(分别是 picker 不显示 / runtime 静默降级)。
  'MiniMax-M3': ['low', 'medium', 'high'],
  'MiniMax-M2.7': ['low', 'medium', 'high'],
  // non-reasoning model:`reasoningEfforts: false` 显式 — zai 不暴露
  // levels,picker 隐藏按钮。
}

function lookupReasoningLevels(model: string): string[] | undefined {
  return MODEL_REASONING_LEVELS[model]
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
