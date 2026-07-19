/**
 * Skills listing section.
 *
 * Wraps the existing `buildSkillsSystemPrompt` (runtime/skills/promptBuilder.ts)
 * — the 8000-char-budget + three-tier downgrade logic — in a section
 * registry entry.
 *
 * Section key includes the skill count so loading/unloading a skill
 * forces recompute. The internal `buildSkillsSystemPrompt` is
 * deterministic per skill set, so caching the rendered block is
 * safe and saves ~8KB of XML on each turn.
 *
 * Returns null when there are no skills (handled inside promptBuilder).
 */

import { buildSkillsSystemPrompt, type LoadedSkill } from '../../runtime/skills/index.js'
import { systemPromptSection } from '../section.js'

export function getSkillsSection(skills: readonly LoadedSkill[]) {
  // Hash by skill names — the body content is fixed at load time;
  // any change to the skill set flips the cache key.
  const fingerprint = skills.map(s => s.name).sort().join('|')
  return systemPromptSection(
    `skills:${fingerprint}`,
    () => buildSkillsSystemPrompt([...skills]) ?? null,
  )
}