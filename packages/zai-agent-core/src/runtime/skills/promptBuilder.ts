import type { LoadedSkill } from './types.js'

export type SkillPromptOptions = {
  /**
   * Character budget for the listing. Defaults to 8000 (1% of a 200k ctx × 4
   * chars/token). Override per environment with `SKILL_BUDGET` env var so
   * tests / specialized deployments don't pay the opencc default tax.
   */
  charBudget?: number
  /**
   * Hard cap per skill description. Verbose whenToUse strings waste turn-1
   * cache_creation tokens without improving match rate. Defaults to 250.
   */
  maxDescriptionChars?: number
}

const DEFAULT_CHAR_BUDGET = 8_000
const DEFAULT_MAX_DESC_CHARS = 250
const MIN_DESC_LENGTH = 20

/**
 * Compose the `<skills>` block shown to the model in the system prompt.
 *
 * Each entry exposes `<name>`, `<description>`, and (when present)
 * `<when_to_use>` / `<argument-hint>`. When the listing exceeds the char
 * budget, descriptions are truncated to fit (description trim) before
 * degrading to "names only" as a last resort.
 *
 * `source === 'bundled'` skills always keep their full description; only
 * non-bundled skills get truncated. This mirrors opencc's behavior so the
 * model never loses the bundled-skill descriptions that ship with zai.
 *
 * Returns null when there are no skills to advertise — caller should skip
 * injecting the section.
 */
export function buildSkillsSystemPrompt(
  skills: LoadedSkill[],
  options?: SkillPromptOptions,
): string | null {
  if (skills.length === 0) return null

  const budget = resolveCharBudget(options?.charBudget)
  const maxDesc = options?.maxDescriptionChars ?? DEFAULT_MAX_DESC_CHARS

  // Phase 1: try to fit everything with full descriptions.
  const entries = skills.map(s => renderSkillEntry(s, maxDesc))
  const totalFull = entries.reduce((sum, e) => sum + e.length, 0)
    + (entries.length - 1) // newlines between entries

  if (totalFull <= budget) {
    return wrapBlock(entries)
  }

  // Phase 2: bundled skills keep their full description; truncate the rest.
  const bundledIndices = new Set<number>()
  const restEntries: Array<{ entry: string; skill: LoadedSkill }> = []
  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i]!
    if (skill.source === 'bundled') {
      bundledIndices.add(i)
    } else {
      restEntries.push({ entry: entries[i]!, skill })
    }
  }

  const bundledChars = entries.reduce(
    (sum, e, i) => (bundledIndices.has(i) ? sum + e.length + 1 : sum),
    0,
  )
  const remaining = budget - bundledChars

  if (restEntries.length === 0) {
    return wrapBlock(entries)
  }

  // Per-rest-entry overhead = `<name>{name}</name>` + `<description>{desc}</description>`
  // + indentation + newlines. Compute the max desc length that fits.
  const restNameOverhead = restEntries.reduce(
    (sum, { skill }) => sum + estimateNameOverhead(skill),
    0,
  ) + (restEntries.length - 1)

  const availableForDescs = remaining - restNameOverhead
  const maxDescLen = Math.floor(availableForDescs / restEntries.length)

  if (maxDescLen < MIN_DESC_LENGTH) {
    // Extreme case: bundled keeps full descriptions, the rest become names-only.
    return wrapBlock(
      entries.map((entry, i) =>
        bundledIndices.has(i) ? entry : renderNameOnly(skills[i]!),
      ),
    )
  }

  // Truncate non-bundled entries.
  return wrapBlock(
    entries.map((entry, i) =>
      bundledIndices.has(i) ? entry : renderSkillEntry(skills[i]!, maxDescLen),
    ),
  )
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function resolveCharBudget(explicit?: number): number {
  if (explicit !== undefined) return explicit
  const envBudget = Number(process.env.ZAI_SKILL_LISTING_BUDGET)
  if (Number.isFinite(envBudget) && envBudget > 0) return envBudget
  return DEFAULT_CHAR_BUDGET
}

function renderSkillEntry(skill: LoadedSkill, maxDescChars: number): string {
  const desc = composeDescription(skill)
  const truncated =
    desc.length > maxDescChars ? desc.slice(0, maxDescChars - 1) + '…' : desc

  const lines: string[] = []
  lines.push(`<name>${escapeXml(skill.name)}</name>`)
  if (skill.frontmatter?.['argument-hint']) {
    lines.push(
      `<argument-hint>${escapeXml(String(skill.frontmatter['argument-hint']))}</argument-hint>`,
    )
  }
  lines.push(`<description>${escapeXml(truncated)}</description>`)
  if (skill.frontmatter?.when_to_use) {
    lines.push(
      `<when_to_use>${escapeXml(String(skill.frontmatter.when_to_use))}</when_to_use>`,
    )
  }
  return `<skill>\n${lines.join('\n')}\n</skill>`
}

function renderNameOnly(skill: LoadedSkill): string {
  return `<skill>\n<name>${escapeXml(skill.name)}</name>\n</skill>`
}

function composeDescription(skill: LoadedSkill): string {
  // Priority: explicit description (frontmatter or top-level) > when_to_use
  // concatenation (opencc-style "- desc - when_to_use") > fallback to empty.
  const desc = skill.description ?? skill.frontmatter?.description ?? ''
  const whenToUse = skill.frontmatter?.when_to_use
  if (whenToUse) return `${desc} - ${whenToUse}`
  return desc
}

function estimateNameOverhead(skill: LoadedSkill): number {
  // `<name>{name}</name>` + `<argument-hint>{hint}</argument-hint>` (rare) +
  // `<description></description>` open/close + indent + newline
  let overhead = skill.name.length + `<name></name>`.length
  if (skill.frontmatter?.['argument-hint']) {
    overhead +=
      String(skill.frontmatter['argument-hint']).length +
      `<argument-hint></argument-hint>`.length
  }
  overhead += `<description></description>`.length
  overhead += 4 // indent + newline
  return overhead
}

function wrapBlock(entries: string[]): string {
  return [
    'The following skills are available for use with the Skill tool:',
    '',
    '<skills>',
    entries.join('\n'),
    '</skills>',
    '',
    'When a skill matches the user\'s intent, invoke it via the Skill tool with the skill name as the `name` argument. Only the frontmatter (name/description) is shown above; the full skill body is injected on invocation.',
  ].join('\n')
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}