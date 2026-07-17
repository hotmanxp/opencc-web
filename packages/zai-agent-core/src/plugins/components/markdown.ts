import yaml from 'js-yaml'
import type { PluginLoadError } from '../types.js'
import { serializeError } from '../errors.js'

/**
 * Result of parsing a plugin markdown file.
 *
 * Exactly one of two shapes:
 *   - Success: `error === null`, `frontmatter` is the parsed mapping
 *     (possibly empty when no fence was found), `body` is the post-fence
 *     text (the entire input when no fence is present).
 *   - Failure: `error` is a structured `PluginLoadError`. `frontmatter`
 *     is `{}`, `body` is the original input so callers can still fall
 *     back to extracting a description from it.
 *
 * Parsing never throws. The `yaml.load` exceptions and shape errors are
 * converted into `plugin_markdown_parse_error` so callers can collect
 * them into `snapshot.errors` without try/catch.
 */
export type ParsePluginMarkdownResult = {
  frontmatter: Record<string, unknown>
  body: string
  error: PluginLoadError | null
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Parse a plugin markdown file (skill, command, agent, ...).
 *
 * Behaviour:
 *   - No opening fence → empty frontmatter, full body.
 *   - Fence present but YAML invalid → typed error, empty frontmatter,
 *     full body preserved for fallback description extraction.
 *   - YAML parses to a non-mapping → typed error (frontmatter must be
 *     a mapping per Claude/OpenCC convention).
 *
 * `filePath` is used for error messages only — it does not affect the
 * returned shape.
 */
export function parsePluginMarkdown(
  content: string,
  filePath: string,
): ParsePluginMarkdownResult {
  if (!content) {
    return { frontmatter: {}, body: '', error: null }
  }

  const match = FRONTMATTER_RE.exec(content)
  if (!match) {
    // No opening fence → no frontmatter block. Body is the whole file.
    return { frontmatter: {}, body: content, error: null }
  }

  const fmBlock = match[1] ?? ''
  const body = match[2] ?? ''

  let parsed: unknown
  try {
    parsed = yaml.load(fmBlock, {
      filename: filePath,
      schema: yaml.CORE_SCHEMA,
      onWarning: () => {},
    })
  } catch (cause) {
    return {
      frontmatter: {},
      body: content,
      error: {
        code: 'plugin_markdown_parse_error',
        message: `Invalid frontmatter in ${filePath}.`,
        path: filePath,
        detail: serializeError(cause),
      },
    }
  }

  if (parsed === undefined || parsed === null) {
    return { frontmatter: {}, body, error: null }
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      frontmatter: {},
      body: content,
      error: {
        code: 'plugin_markdown_parse_error',
        message: `Frontmatter in ${filePath} must be a mapping, got ${
          Array.isArray(parsed) ? 'array' : typeof parsed
        }.`,
        path: filePath,
      },
    }
  }

  // Reject keys starting with `-` — those almost always indicate the
  // author wrote a list bullet rather than a real mapping entry. Matches
  // the existing `parseSkillFrontmatter` constraint.
  for (const k of Object.keys(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z_][\w-]*$/.test(k)) {
      return {
        frontmatter: {},
        body: content,
        error: {
          code: 'plugin_markdown_parse_error',
          message: `Invalid frontmatter key "${k}" in ${filePath} — keys must match /^[A-Za-z_][\\w-]*$/.`,
          path: filePath,
        },
      }
    }
  }

  return {
    frontmatter: parsed as Record<string, unknown>,
    body,
    error: null,
  }
}