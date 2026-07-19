/**
 * Local file helpers — inlined from `opencc-internals/utils/file.ts` to avoid
 * pulling in that module's bare `src/services/analytics/...` imports (which
 * break under Bun bundling into the zai-agent-core dist).
 *
 * Only the subset the Read tool needs at runtime; do not expand without reason.
 */
import { readdir, realpath, stat } from 'fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'path'

/** Marker included in file-not-found error messages. UI renderers check for
 *  this to show a short "File not found" message. Mirrors opencc's constant. */
export const FILE_NOT_FOUND_CWD_NOTE =
  'Note: your current working directory is'

/**
 * Async file modification time. Math.floor matches opencc semantics so timestamp
 * comparisons across reads/writes stay consistent.
 */
export async function getFileModificationTimeAsync(
  filePath: string,
): Promise<number> {
  const s = await stat(filePath)
  return Math.floor(s.mtimeMs)
}

/**
 * Find files with the same name but different extension in the same directory.
 * Mirrors opencc `findSimilarFile`. Returns the first match's basename or undefined.
 */
export async function findSimilarFile(
  filePath: string,
): Promise<string | undefined> {
  try {
    const dir = dirname(filePath)
    const fileBaseName = basename(filePath, extname(filePath))
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (basename(entry.name, extname(entry.name)) !== fileBaseName) continue
      if (join(dir, entry.name) === filePath) continue
      return entry.name
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Suggest a corrected path under cwd when the requested path's parent matches
 * cwd's parent but the path is missing the repo-root component.
 *
 * Example:
 *   cwd = /Users/zeeg/src/currentRepo
 *   requestedPath = /Users/zeeg/src/foobar           (doesn't exist)
 *   returns        /Users/zeeg/src/currentRepo/foobar (if it exists)
 */
export async function suggestPathUnderCwd(
  requestedPath: string,
  cwd: string,
): Promise<string | undefined> {
  const cwdParent = dirname(cwd)
  let resolvedPath = requestedPath
  try {
    const resolvedDir = await realpath(dirname(requestedPath))
    resolvedPath = join(resolvedDir, basename(requestedPath))
  } catch {
    // Parent dir missing — fall through with original path.
  }

  const cwdParentPrefix = cwdParent === sep ? sep : cwdParent + sep
  if (
    !resolvedPath.startsWith(cwdParentPrefix) ||
    resolvedPath.startsWith(cwd + sep) ||
    resolvedPath === cwd
  ) {
    return undefined
  }

  const relFromParent = relative(cwdParent, resolvedPath)
  const correctedPath = join(cwd, relFromParent)
  try {
    await stat(correctedPath)
    return correctedPath
  } catch {
    return undefined
  }
}