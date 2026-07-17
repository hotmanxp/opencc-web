import { realpath, readFile, stat } from 'fs/promises'
import { join, relative, resolve, sep, isAbsolute } from 'path'
import { z } from 'zod'
import type { PluginComponent, PluginLoadError, PluginManifest } from './types.js'
import {
  manifestDuplicatePathsError,
  manifestInvalidError,
  manifestNotFoundError,
  manifestParseError,
  pathOutsideRootError,
} from './errors.js'

/**
 * Result of attempting to read + parse a plugin manifest from disk.
 * Exactly one of `manifest` and `error` is populated on success; on
 * success `manifestPath` is the file that was read; on a "not found"
 * error `manifestPath` is `null`.
 */
export type ReadPluginManifestResult = {
  manifest: PluginManifest | null
  manifestPath: string | null
  error: PluginLoadError | null
}

const NESTED_MANIFEST = join('.claude-plugin', 'plugin.json')
const ROOT_MANIFEST = 'plugin.json'

/**
 * Name rule: lowercase leading letter, then lowercase letters / digits / dashes.
 * Rejects whitespace, slashes, uppercase, leading digits/underscore — same
 * shape OpenCC uses for plugin identifier segments.
 */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/

const ManifestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(NAME_PATTERN, {
        message:
          'name must start with a lowercase letter and contain only lowercase letters, digits, and dashes',
      }),
  })
  .passthrough()

/**
 * Read and parse the plugin manifest from `root`.
 *
 * Lookup order:
 *   1. `<root>/.claude-plugin/plugin.json`
 *   2. `<root>/plugin.json`
 *
 * Errors are returned in the result object — this function never throws
 * for missing files or bad JSON.
 */
export async function readPluginManifest(root: string): Promise<ReadPluginManifestResult> {
  const nestedPath = join(root, NESTED_MANIFEST)
  const rootPath = join(root, ROOT_MANIFEST)

  const [nestedStat, rootStat] = await Promise.all([
    safeStat(nestedPath),
    safeStat(rootPath),
  ])

  if (nestedStat && rootStat) {
    return {
      manifest: null,
      manifestPath: null,
      error: manifestDuplicatePathsError(nestedPath, rootPath),
    }
  }

  const chosen = nestedStat ? nestedPath : rootStat ? rootPath : null
  if (chosen === null) {
    return {
      manifest: null,
      manifestPath: null,
      error: manifestNotFoundError({ path: root }),
    }
  }

  let raw: string
  try {
    raw = await readFile(chosen, 'utf8')
  } catch (cause) {
    return {
      manifest: null,
      manifestPath: chosen,
      error: manifestParseError(chosen, cause, { path: chosen }),
    }
  }

  let parsedRaw: unknown
  try {
    parsedRaw = JSON.parse(raw)
  } catch (cause) {
    return {
      manifest: null,
      manifestPath: chosen,
      error: manifestParseError(chosen, cause, { path: chosen }),
    }
  }

  const parsed = parsePluginManifest(parsedRaw, chosen)
  return { manifest: parsed.manifest, manifestPath: chosen, error: parsed.error }
}

/**
 * Validate a parsed JSON manifest against the Zod schema. Unknown fields
 * pass through (OpenCC plugins declare extras).
 */
export function parsePluginManifest(
  raw: unknown,
  manifestPath: string | null,
): { manifest: PluginManifest | null; error: PluginLoadError | null } {
  const result = ManifestSchema.safeParse(raw)
  if (!result.success) {
    const reason = result.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    return {
      manifest: null,
      error: manifestInvalidError(reason, { path: manifestPath ?? undefined }),
    }
  }
  return { manifest: result.data as PluginManifest, error: null }
}

/**
 * Resolve a component path inside a plugin root, rejecting anything that
 * escapes the root via `..`, absolute paths, or symlinks.
 *
 * This is the security gate that ALL later component loaders
 * (skills/commands/agents/MCP/hooks) MUST funnel reads through.
 *
 * On success returns the absolute path. On violation rejects with an
 * `Error` whose `code` is `'plugin_path_outside_root'` and whose shape
 * matches `PluginLoadError`. The thrown object is an `Error` (so callers
 * using `try/catch` get a stack) but every field of `PluginLoadError` is
 * present.
 */
export async function resolvePluginPath(
  root: string,
  relPath: string,
  component: PluginComponent,
): Promise<string> {
  // Reject absolute paths and `..` segments before touching the disk.
  if (isAbsolute(relPath)) {
    throw pathOutsideRootError(root, relPath, component, relPath)
  }
  const segments = relPath.split(/[\\/]+/)
  if (segments.some(seg => seg === '..' || seg === '')) {
    // Disallow empty segments (`a//b`) and explicit parent traversal.
    const joined = resolve(root, relPath)
    throw pathOutsideRootError(root, relPath, component, joined)
  }

  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    // Root doesn't exist on disk → cannot prove containment → reject.
    throw pathOutsideRootError(root, relPath, component, resolve(root, relPath))
  }

  // Build the candidate against `realRoot`, not the lexical `root`. On
  // macOS, `tmpdir()` returns paths under `/var` which is a symlink to
  // `/private/var`; `realpath` resolves the root to `/private/var/...`
  // but a lexically-built candidate would still be under `/var/...`,
  // so `relative()` would incorrectly report the candidate as escaping
  // root. Anchoring to `realRoot` keeps both sides consistent.
  const candidate = resolve(realRoot, relPath)

  let realCandidate: string
  try {
    realCandidate = await realpath(candidate)
  } catch {
    // Candidate doesn't exist (yet) — fine for callers that want the
    // resolved path to write to. Containment already follows from
    // building the candidate against `realRoot` after rejecting `..`
    // and absolute paths.
    return candidate
  }

  // Containment check: realCandidate must equal realRoot or live under it.
  const rel = relative(realRoot, realCandidate)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw pathOutsideRootError(root, relPath, component, realCandidate)
  }
  // Defence-in-depth: ensure the boundary is segment-aligned.
  const withSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep
  if (!(realCandidate === realRoot || realCandidate.startsWith(withSep))) {
    throw pathOutsideRootError(root, relPath, component, realCandidate)
  }
  return realCandidate
}

/**
 * Read a JSON file if present, otherwise return null. ENOENT is the only
 * "soft" error — anything else (parse failure, EACCES, EISDIR, ...) is
 * propagated so callers don't silently swallow real problems.
 */
export async function readJsonFileIfPresent(path: string): Promise<unknown | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (cause) {
    if (isEnoent(cause)) return null
    throw cause
  }
  return JSON.parse(raw)
}

async function safeStat(p: string): Promise<ReturnType<typeof stat> | null> {
  try {
    return await stat(p)
  } catch (cause) {
    if (isEnoent(cause)) return null
    throw cause
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}