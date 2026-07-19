/**
 * Build the system prompt for a query.
 *
 * Layout:
 *
 *   [staticIntro..., BOUNDARY, dynamicSection1, dynamicSection2, ...]
 *
 * `staticIntro` is supplied by the caller (via `effective.ts`
 * arbitration, or by the host application). When the caller passes
 * none, we fall back to `DEFAULT_STATIC_INTRO` (the 7-section opencc-
 * style block) so the model always has identity / task discipline /
 * tone guidance even if the host forgot.
 *
 * Dynamic sections are resolved through the section registry. Each
 * section is named and cached; the cache is invalidated on
 * `clearSystemPromptSections()` (called by /clear and /compact).
 *
 * Boundary handling: the BOUNDARY string is included in the returned
 * array verbatim. Downstream consumers (modelCaller.ts, Anthropic
 * payload assembly) filter it out before sending to the model. The
 * marker exists so the array shape is self-describing and so a
 * future Anthropic `cache_control: { type: 'ephemeral' }` insertion
 * can split on this exact byte boundary.
 *
 * Mirrors opencc's `getSystemPrompt` (prompts.ts:460-599) and the
 * cache-split pattern from `services/api/claude.ts:buildSystemPromptBlocks`.
 */

import { asSystemPrompt, type SystemPrompt } from './type.js'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './boundary.js'
import { resolveSystemPromptSections, type SystemPromptSection } from './section.js'
import { DEFAULT_STATIC_INTRO } from './defaults.js'

export type BuildSystemPromptInput = {
  /** Caller-provided static intro. Empty/missing → DEFAULT_STATIC_INTRO. */
  staticIntro?: readonly string[] | string
  /** Named + cached dynamic sections. */
  sections: readonly SystemPromptSection[]
}

export async function buildSystemPrompt(
  input: BuildSystemPromptInput,
): Promise<SystemPrompt> {
  const intro = normalizeIntro(input.staticIntro)
  const dynamicSections = await resolveSystemPromptSections(input.sections)

  return asSystemPrompt(
    [
      ...intro,
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      ...dynamicSections.filter((s): s is string => s !== null),
    ],
  )
}

function normalizeIntro(intro: readonly string[] | string | undefined): readonly string[] {
  // undefined  → "未传" → fallback to DEFAULT_STATIC_INTRO (7 sections)
  // '' or []   → "显式传空" → respect the empty choice (no fallback)
  // string     → wrap in single-element array
  // non-empty array → use as-is
  if (intro === undefined) return DEFAULT_STATIC_INTRO
  if (typeof intro === 'string') return [intro]
  return intro
}