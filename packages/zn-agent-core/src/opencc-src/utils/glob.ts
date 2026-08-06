import { basename, dirname, isAbsolute, join, sep } from 'path'
import type { ToolPermissionContext } from '../Tool.js'
import { isEnvTruthy } from './envUtils.js'
import {
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from './permissions/filesystem.js'
import { getPlatform } from './platform.js'
import { getGlobExclusionsForPluginCache } from './plugins/orphanedPluginFilter.js'
import { ripGrep } from './ripgrep.js'
import { getInitialSettings } from './settings/settings.js'

/**
 * Extracts the static base directory from a glob pattern.
 * The base directory is everything before the first glob special character (* ? [ {).
 * Returns the directory portion and the remaining relative pattern.
 */
export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string
  relativePattern: string
} {
  // Find the first glob special character: *, ?, [, {
  const globChars = /[*?[{]/
  const match = pattern.match(globChars)

  if (!match || match.index === undefined) {
    // No glob characters - this is a literal path
    // Return the directory portion and filename as pattern
    const dir = dirname(pattern)
    const file = basename(pattern)
    return { baseDir: dir, relativePattern: file }
  }

  // Get everything before the first glob character
  const staticPrefix = pattern.slice(0, match.index)

  // Find the last path separator in the static prefix
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf('/'),
    staticPrefix.lastIndexOf(sep),
  )

  if (lastSepIndex === -1) {
    // No path separator before the glob - pattern is relative to cwd
    return { baseDir: '', relativePattern: pattern }
  }

  let baseDir = staticPrefix.slice(0, lastSepIndex)
  const relativePattern = pattern.slice(lastSepIndex + 1)

  // Handle root directory patterns (e.g., /*.txt on Unix or C:/*.txt on Windows)
  // When lastSepIndex is 0, baseDir is empty but we need to use '/' as the root
  if (baseDir === '' && lastSepIndex === 0) {
    baseDir = '/'
  }

  // Handle Windows drive root paths (e.g., C:/*.txt)
  // 'C:' means "current directory on drive C" (relative), not root
  // We need 'C:/' or 'C:\' for the actual drive root
  if (getPlatform() === 'windows' && /^[A-Za-z]:$/.test(baseDir)) {
    baseDir = baseDir + sep
  }

  return { baseDir, relativePattern }
}

/**
 * Default patterns always excluded from glob results, in addition to user-
 * configured exclusions and .gitignore. Mirrors GrepTool's
 * VCS_DIRECTORIES_TO_EXCLUDE but extended with node_modules which GrepTool
 * happens to skip because its typical callers don't recurse into dependency
 * trees. GlobTool is used for codebase exploration and almost always needs
 * these skipped to keep result sets sane.
 *
 * Patterns are passed to ripgrep via `--glob !{pattern}` — ripgrep matches
 * directory name anywhere in the path, so `node_modules` correctly excludes
 */
const DEFAULT_EXCLUDE_PATTERNS = ['node_modules', '.git', '.svn', '.hg']

export async function glob(
  filePattern: string,
  cwd: string,
  { limit, offset }: { limit: number; offset: number },
  abortSignal: AbortSignal,
  toolPermissionContext: ToolPermissionContext,
): Promise<{ files: string[]; truncated: boolean }> {
  let searchDir = cwd
  let searchPattern = filePattern

  // Handle absolute paths by extracting the base directory and converting to relative pattern
  // ripgrep's --glob flag only works with relative patterns
  if (isAbsolute(filePattern)) {
    const { baseDir, relativePattern } = extractGlobBaseDirectory(filePattern)
    if (baseDir) {
      searchDir = baseDir
      searchPattern = relativePattern
    }
  }

  const ignorePatterns = normalizePatternsToPath(
    getFileReadIgnorePatterns(toolPermissionContext),
    searchDir,
  )

  // Read glob settings: respectGitIgnore defaults to true (ripgrep respects
  // .gitignore natively when --no-ignore is not passed), and user may add
  // extra exclude patterns on top of the built-in defaults.
  const globSettings = getInitialSettings().glob
  const respectGitIgnore = globSettings?.respectGitIgnore ?? true
  const additionalExcludePatterns = globSettings?.additionalExcludePatterns ?? []

  // Use ripgrep for better memory performance
  // --files: list files instead of searching content
  // --glob: filter by pattern
  // --sort=modified: sort by modification time (oldest first)
  // --no-ignore: don't respect .gitignore. Defaults from settings
  //   (glob.respectGitIgnore, default true); env var CLAUDE_CODE_GLOB_NO_IGNORE
  //   wins for backward compat — set to "true" to restore old "search everywhere"
  //   behavior.
  // --hidden: include hidden files (default true, set CLAUDE_CODE_GLOB_HIDDEN=false to exclude)
  // Note: use || instead of ?? to treat empty string as unset (defaulting to settings-derived value)
  const noIgnore = isEnvTruthy(
    process.env.CLAUDE_CODE_GLOB_NO_IGNORE || (!respectGitIgnore).toString(),
  )
  const hidden = isEnvTruthy(process.env.CLAUDE_CODE_GLOB_HIDDEN || 'true')
  const args = [
    '--files',
    '--glob',
    searchPattern,
    '--sort=modified',
    ...(noIgnore ? ['--no-ignore'] : []),
    ...(hidden ? ['--hidden'] : []),
  ]

  // Add built-in default exclude patterns (node_modules, VCS dirs).
  // These apply regardless of .gitignore so the tool stays useful even when
  // .gitignore is absent (e.g. fresh repos without git init).
  for (const pattern of DEFAULT_EXCLUDE_PATTERNS) {
    args.push('--glob', `!${pattern}`)
  }

  // Add user-configured additional exclude patterns (from settings.globs)
  for (const pattern of additionalExcludePatterns) {
    args.push('--glob', `!${pattern}`)
  }

  // Add ignore patterns from permission system deny rules
  for (const pattern of ignorePatterns) {
    args.push('--glob', `!${pattern}`)
  }

  // Exclude orphaned plugin version directories
  for (const exclusion of await getGlobExclusionsForPluginCache(searchDir)) {
    args.push('--glob', exclusion)
  }

  const allPaths = await ripGrep(args, searchDir, abortSignal)

  // ripgrep returns relative paths, convert to absolute
  const absolutePaths = allPaths.map(p =>
    isAbsolute(p) ? p : join(searchDir, p),
  )

  const truncated = absolutePaths.length > offset + limit
  const files = absolutePaths.slice(offset, offset + limit)

  return { files, truncated }
}
