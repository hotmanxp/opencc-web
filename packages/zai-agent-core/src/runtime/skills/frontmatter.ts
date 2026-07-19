import type { SkillFrontmatter } from './types.js'
import yaml from 'js-yaml'

// Capture the first fence pair (---...\n---). No pair → no frontmatter block.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parseSkillFrontmatter(
  raw: string,
  filename?: string,
): { frontmatter: SkillFrontmatter; body: string } {
  if (!raw) return { frontmatter: {}, body: '' }

  const match = FRONTMATTER_RE.exec(raw)
  if (!match) return { frontmatter: {}, body: raw }

  const [, fmBlock, body] = match
  const frontmatter = parseFrontmatterBlock(fmBlock ?? '', filename)
  return { frontmatter, body: body ?? '' }
}

function parseFrontmatterBlock(
  block: string,
  filename?: string,
): SkillFrontmatter {
  let parsed: unknown
  try {
    // CORE_SCHEMA gives: bool / int / float / null / string / array / mapping /
    // timestamp — matches every frontmatter shape Claude/OpenCC skills actually
    // use, while keeping `on:` off so JS objects pass through. Timestamp values
    // land as Date, which tests don't assert against.
    parsed = yaml.load(block, {
      filename,
      schema: yaml.CORE_SCHEMA,
      // Suppress dup-key warnings to console; we don't act on them but they
      // would otherwise flood logs when real-world skills hit the loader.
      onWarning: () => {},
    })
  } catch (err) {
    throw new Error(
      `Invalid frontmatter${filename ? ` in ${filename}` : ''}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (parsed === undefined || parsed === null) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    // YAML produced something other than a mapping (e.g. a bare string, number,
    // or sequence). Frontmatter is structurally required to be an object so the
    // rest of the loader has stable keys. Throw here so callers can react.
    throw new Error(
      `Invalid frontmatter${filename ? ` in ${filename}` : ''}: expected mapping, got ${
        Array.isArray(parsed) ? 'array' : typeof parsed
      }`,
    )
  }
  // js-yaml accepts `"-invalid: x"` as a mapping with the literal key "-invalid",
  // but a leading "-" in a frontmatter key almost always means the author
  // accidentally wrote a list bullet when they meant a normal mapping entry.
  // Skill keys (per OpenCC / Claude convention) are [A-Za-z_][\w-]*, matching
  // e.g. "disable-model-invocation" but rejecting "-invalid".
  for (const k of Object.keys(parsed)) {
    if (!/^[A-Za-z_][\w-]*$/.test(k)) {
      throw new Error(
        `Invalid frontmatter${filename ? ` in ${filename}` : ''}: invalid key "${k}" — keys must match /^[A-Za-z_][\\w-]*$/`,
      )
    }
  }
  return parsed as SkillFrontmatter
}

// ---------------------------------------------------------------------------
// Field parsers (opencc-faithful helpers used by SkillTool / loader)
// ---------------------------------------------------------------------------

/**
 * Standard effort level names accepted by zai's runtime.
 * Matches opencc's EFFORT_LEVELS minus 'ultracode' (an orchestration mode
 * specific to upstream Claude Code that zai doesn't replicate).
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const

export type EffortLevel = (typeof EFFORT_LEVELS)[number]
export type EffortValue = EffortLevel | number

/**
 * Coerce a frontmatter `description` value to a string.
 *
 * YAML may parse unquoted `description: yes` as the boolean `true`. Skill
 * descriptions must always be a string; fall back to '' if the coerced value
 * isn't a string. Matches opencc's `coerceDescriptionToString`.
 */
export function coerceDescriptionToString(
  value: unknown,
  skillName: string,
): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  // Arrays / objects → not a valid description; return null so the loader
  // falls back to extracting the first markdown paragraph.
  return null
}

/**
 * Parse a frontmatter boolean field, mirroring opencc's `parseBooleanFrontmatter`.
 *
 * Accepts: true/false (booleans), "true"/"false" (strings), "yes"/"no"
 * (legacy string forms). Anything else returns `defaultValue`.
 */
export function parseBooleanFrontmatter(
  value: unknown,
  defaultValue = false,
): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === 'yes' || v === 'on' || v === '1') return true
    if (v === 'false' || v === 'no' || v === 'off' || v === '0') return false
  }
  return defaultValue
}

/**
 * Parse an effort value from frontmatter.
 *
 * Accepts:
 *  - string level: 'low' | 'medium' | 'high' | 'max'
 *  - positive integer (clamped via isValidNumericEffort)
 *  - numeric string ("100" → 100)
 *
 * Returns undefined if the value is missing / unparseable so callers can
 * distinguish "no override" from "explicitly set to a level".
 */
export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined
  }
  if (typeof value === 'string') {
    const str = value.toLowerCase().trim()
    if ((EFFORT_LEVELS as readonly string[]).includes(str)) {
      return str as EffortLevel
    }
    const num = parseInt(str, 10)
    if (!Number.isNaN(num) && Number.isInteger(num)) return num
  }
  return undefined
}

/**
 * Parse a `paths:` frontmatter field into a normalized array.
 *
 * Frontmatter form is identical to AGENTS.md `paths` rules: string or
 * string[]. `/**` suffix is stripped (the `ignore` library treats a path
 * and its contents identically). Patterns consisting entirely of `**` are
 * filtered out — they would match everything and provide no signal.
 */
export function splitPathInFrontmatter(
  value: string | string[] | undefined,
): string[] {
  if (!value) return []
  const arr = Array.isArray(value) ? value : [value]
  return arr
    .map(p => (typeof p === 'string' ? p.trim() : ''))
    .filter(p => p.length > 0)
    .map(p => (p.endsWith('/**') ? p.slice(0, -3) : p))
    .filter(p => p !== '**')
}

/**
 * Parse a `shell:` frontmatter field. Mirrors opencc's `parseShellFrontmatter`.
 *
 * Accepted shapes:
 *   shell: bash                → shell name (e.g. 'bash', 'sh', 'zsh')
 *   shell: { name: bash }      → wrapped object form
 *   shell: { name: bash, args: ['-l'] } → with default args
 *
 * Returns undefined when invalid so callers can fall back to bash defaults.
 */
export type SkillShell = {
  name: string
  args?: string[]
}

export function parseShellFrontmatter(
  value: unknown,
  skillName: string,
): SkillShell | undefined {
  if (value === undefined || value === null) return undefined

  if (typeof value === 'string') {
    const name = value.trim()
    if (!name) return undefined
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      // Log + bail rather than throw — invalid shell name should not abort
      // skill loading (matches opencc: logForDebugging).
      console.warn(
        `[skills] ${skillName}: invalid shell name '${name}', falling back to bash`,
      )
      return undefined
    }
    return { name }
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as { name?: unknown; args?: unknown }
    if (typeof obj.name !== 'string') return undefined
    const name = obj.name.trim()
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return undefined
    const args =
      Array.isArray(obj.args) && obj.args.every(a => typeof a === 'string')
        ? (obj.args as string[])
        : undefined
    return { name, ...(args ? { args } : {}) }
  }

  return undefined
}