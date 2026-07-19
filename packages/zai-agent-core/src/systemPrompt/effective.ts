/**
 * Build the effective system prompt.
 *
 * Mirrors opencc's `buildEffectiveSystemPrompt` (utils/systemPrompt.ts:40-112).
 *
 * Priority (later = lower):
 *
 *   0. overrideSystemPrompt          — loop-mode REPLACES everything
 *   1. coordinatorSystemPrompt       — coordinator mode (zai: N/A)
 *   2. agentSystemPrompt             — main-thread agent definition
 *   3. customSystemPrompt            — caller-provided override
 *   4. defaultSystemPrompt           — from `buildSystemPrompt`
 *   +. appendSystemPrompt            — always appended (except override)
 *
 * zai simplifies this to four cases:
 *
 *   - override   → [override, ...append]
 *   - custom     → [custom, ...append]   (default sections appended via buildSystemPrompt? no — caller must compose)
 *   - default    → buildSystemPrompt(staticIntro = DEFAULT_STATIC_INTRO)
 *   - + append   → appended at the end of whatever won above
 *
 * For the typical "host calls queryLoop with no systemPrompt" path we
 * return the full default build: 7 static sections + boundary + every
 * dynamic section. For "host provides customSystemPrompt" we splice
 * the custom block into the static half and keep the dynamic sections
 * intact.
 *
 * Subtle: when `customSystemPrompt` is set we still call
 * `buildSystemPrompt` (without a custom staticIntro) so the dynamic
 * sections are resolved identically. The custom string replaces
 * DEFAULT_STATIC_INTRO.
 */

import { asSystemPrompt, type SystemPrompt } from './type.js'
import { buildSystemPrompt } from './buildSystemPrompt.js'
import type { SystemPromptSection } from './section.js'

export type BuildEffectiveSystemPromptInput = {
  /** Caller-computed dynamic sections. Required. */
  sections: readonly SystemPromptSection[]
  /** Replace everything (loop mode / escape hatch). */
  overrideSystemPrompt?: string | string[] | null
  /** Caller-provided custom static intro (replaces DEFAULT_STATIC_INTRO). */
  customSystemPrompt?: string | string[]
  /** Always appended at the end, unless `override` is set. */
  appendSystemPrompt?: string
}

export async function buildEffectiveSystemPrompt(
  input: BuildEffectiveSystemPromptInput,
): Promise<SystemPrompt> {
  if (input.overrideSystemPrompt) {
    const override = normalize(input.overrideSystemPrompt)
    return asSystemPrompt([
      ...override,
      ...(input.appendSystemPrompt ? [input.appendSystemPrompt] : []),
    ])
  }

  const customIntro = input.customSystemPrompt
    ? normalize(input.customSystemPrompt)
    : undefined

  const built = await buildSystemPrompt({
    staticIntro: customIntro,
    sections: input.sections,
  })

  if (input.appendSystemPrompt) {
    // Append lives AFTER the boundary in the dynamic half is wrong — it
    // should be the final user-supplied instruction. We splice it
    // right after the boundary so it sees all dynamic sections but
    // isn't itself cached.
    return spliceAppendAfterBoundary(built, input.appendSystemPrompt)
  }

  return built
}

function normalize(p: string | readonly string[]): readonly string[] {
  return typeof p === 'string' ? [p] : p
}

function spliceAppendAfterBoundary(
  built: SystemPrompt,
  append: string,
): SystemPrompt {
  const idx = built.indexOf('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
  if (idx === -1) return asSystemPrompt([...built, append])
  return asSystemPrompt([
    ...built.slice(0, idx + 1),
    append,
    ...built.slice(idx + 1),
  ])
}