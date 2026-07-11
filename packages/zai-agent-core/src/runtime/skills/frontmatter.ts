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
