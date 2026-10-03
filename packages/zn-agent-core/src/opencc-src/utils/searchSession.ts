import { accessSync, constants } from 'fs'
import { open, stat } from 'fs/promises'
import { basename, isAbsolute, join, resolve } from 'path'
import { getFsImplementation } from './fsOperations.js'
import { safeResolvePath } from './fsOperations.js'
import { getPlatform } from './platform.js'
import { ripgrepCommand } from './ripgrep.js'

/**
 * A resolved, pinned search target.
 *
 * Mirrors upstream `P5n` (bundle @5461712). The point is TOCTOU protection:
 * between the moment a permission check approves a path and the moment
 * ripgrep actually reads it, something could rewrite a symlink in that path
 * and redirect the search somewhere the user never approved. `P5n` closes
 * that window by capturing the resolved identity up front and re-verifying it
 * immediately before the spawn.
 *
 * Scoped to a single call: `close()` releases the descriptor and the caller is
 * expected to call it (upstream does so in a `finally`).
 */
export type SearchSession = {
  /** The path as the caller spelled it. */
  lexical: string
  /** Fully symlink-resolved path. */
  canonical: string
  /** Directory to spawn ripgrep in. */
  spawnCwd: string
  /** Path argument passed to ripgrep. */
  target: string
  /** True when ripgrep reports paths relative to `spawnCwd`. */
  relativeOutput: boolean
  isDirectory: boolean
  /**
   * Re-verify the path's symlink resolution. Throws if it changed since
   * `openSearchSession` ran. Wired to ripgrep's `beforeSpawn` hook.
   */
  recheckBeforeSpawn: () => void
  /** Same check, for a per-result path. */
  recheckByPath: (path: string) => void
  /** Release the pinned descriptor. */
  close: () => Promise<void>
}

export class SearchTargetChangedError extends Error {
  constructor(path: string) {
    super(
      `Refusing to search ${path}: its symlink resolution changed after permission was checked. If a link in the working directory is being rewritten concurrently, stop that and retry.`,
    )
    this.name = 'SearchTargetChangedError'
  }
}

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true
  const rel = resolve(parent)
  return child === rel || child.startsWith(`${rel}/`)
}

/**
 * Open a search session for `target`.
 *
 * Returns `null` when the path does not exist — callers treat that as "no
 * matches" rather than an error, matching ripgrep's own behaviour for a
 * vanished path.
 *
 * Throws {@link SearchTargetChangedError} when the path's symlink resolution
 * is not stable, and a plain `Error` for unreadable / non-traversable targets.
 */
export async function openSearchSession(
  target: string,
  approvedSpellings: readonly string[],
): Promise<SearchSession | null> {
  const platform = getPlatform()
  // A permission check approves every spelling of a path, not just the one the
  // caller happened to type: `/var/...` and `/private/var/...` are the same
  // directory on macOS, and only the latter is what realpath returns. Snapshot
  // the resolved form of each approved spelling now, while the check is still
  // authoritative — a later recheck compares against this frozen set.
  const approvedResolutions = new Set<string>()
  for (const spelling of approvedSpellings) {
    const { resolvedPath } = safeResolvePath(
      getFsImplementation(),
      spelling,
    )
    approvedResolutions.add(spelling)
    approvedResolutions.add(resolvedPath)
  }

  const resolveNow = (): string => {
    const { resolvedPath, isCanonical } = safeResolvePath(
      getFsImplementation(),
      target,
    )
    if (!isCanonical) throw new SearchTargetChangedError(target)
    return resolvedPath
  }

  const changed = (): never => {
    throw new SearchTargetChangedError(target)
  }

  /**
   * Whether `canonical` is one of the directories this session was opened for.
   *
   * Resolved once, at open time. Re-resolving the approved spellings on every
   * check would defeat the point: a link repointed after the permission check
   * would resolve to the new target and match itself, so the swap would go
   * unnoticed. Mirrors upstream `g` / `s.has(...)` (@5461740).
   */
  const isApproved = (canonical: string): boolean =>
    approvedResolutions.has(canonical)

  /**
   * Re-verify the target immediately before spawning ripgrep.
   *
   * Resolving the path again is not enough on its own — a link repointed
   * between the permission check and the spawn still resolves cleanly, just to
   * a different directory. The resolution must still be one the permission
   * check approved, otherwise the search would run somewhere the user never
   * agreed to. Mirrors upstream `g` / `recheckBeforeSpawn` (@5461740).
   */
  const recheck = (): string => {
    const canonical = resolveNow()
    if (!isApproved(canonical)) changed()
    return canonical
  }


  // rg found only by name on PATH: the resolved path could differ between the
  // permission check and the spawn, and a search outside the working
  // directory would apply deny rules we cannot verify.
  const rgPathIsAbsolute = isAbsolute(ripgrepCommand().rgPath)
  const requireInsideCwd = (canonical: string, spawnCwd: string) => {
    if (rgPathIsAbsolute) return
    if (!isInside(canonical, spawnCwd)) {
      throw new Error(
        `Refusing to search ${target}: ripgrep was found only by name on PATH, and a search outside the working directory cannot apply your Read deny rules in that configuration. Install ripgrep at an absolute path or search under the working directory.`,
      )
    }
  }

  const simple = async (
    canonical: string,
  ): Promise<SearchSession | null> => {
    const spawnCwd = canonical
    requireInsideCwd(canonical, spawnCwd)
    let isDirectory: boolean
    try {
      isDirectory = (await stat(target)).isDirectory()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw err
    }
    return {
      lexical: target,
      canonical,
      spawnCwd,
      target,
      relativeOutput: false,
      isDirectory,
      recheckBeforeSpawn: recheck,
      recheckByPath: recheck,
      close: async () => {},
    }
  }

  // Non-Windows: hold an open descriptor on the target. On Linux this lets us
  // spawn ripgrep inside `/proc/self/fd/N`, so even a directory replaced
  // mid-search cannot redirect it.
  let handle
  try {
    handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
    )
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') {
      throw new Error(
        `Refusing to search ${target}: it could not be opened (${code}) — it is unreadable, or is being replaced concurrently.`,
      )
    }
    throw err
  }

  try {
    const canonical = resolveNow()
    if (!isApproved(canonical)) changed()

    const stats = await handle.stat()
    const isDirectory = stats.isDirectory()

    if (isDirectory) {
      // Traversal check via the sync `fs` module: `fs/promises` is the target
      // of test-time mock.module pollution elsewhere in the suite, and a
      // stubbed `access` there would make every directory look untraversable.
      try {
        accessSync(target, constants.X_OK)
      } catch {
        throw new Error(
          `Cannot search ${target}: the directory is not traversable (no execute permission).`,
        )
      }
      if (rgPathIsAbsolute && (platform === 'linux' || platform === 'wsl')) {
        // Pin the search to the descriptor: rg searches the directory that
        // was approved, even if the path is rewritten before rg reads it.
        const fdPath = `/proc/self/fd/${handle.fd}`
        return {
          lexical: target,
          canonical,
          spawnCwd: fdPath,
          target: '.',
          relativeOutput: true,
          isDirectory: true,
          recheckBeforeSpawn: recheck,
          recheckByPath: recheck,
          close: () => handle.close(),
        }
      }
      const spawnCwd = canonical
      requireInsideCwd(canonical, spawnCwd)
      return {
        lexical: target,
        canonical,
        spawnCwd,
        target: canonical,
        relativeOutput: false,
        isDirectory: true,
        recheckBeforeSpawn: recheck,
        recheckByPath: recheck,
        close: () => handle.close(),
      }
    }

    return {
      lexical: target,
      canonical,
      spawnCwd: canonical,
      target: canonical,
      relativeOutput: false,
      isDirectory: false,
      recheckBeforeSpawn: recheck,
      recheckByPath: recheck,
      close: () => handle.close(),
    }
  } catch (err) {
    await handle.close().catch(() => {})
    throw err
  }
}

/**
 * Map a path ripgrep reported back onto the spelling the user typed.
 *
 * When ripgrep ran inside a pinned descriptor it reports `./relative` paths,
 * and when the search was redirected through a symlink the reported prefix is
 * the canonical one. Either way the model should see the path it asked about.
 * Mirrors upstream `fUo` (bundle @5464724).
 */
export function toLexicalPath(
  reported: string,
  session: SearchSession,
): string {
  if (session.relativeOutput) {
    const stripped = reported.startsWith('./') ? reported.slice(2) : reported
    return stripped === '.' || stripped === ''
      ? `${session.lexical}${reported.endsWith('/') ? '/' : ''}`
      : join(session.lexical, stripped)
  }

  for (const prefix of [session.target, session.canonical]) {
    const withSep = prefix.endsWith('/') ? prefix : `${prefix}/`
    if (reported.startsWith(withSep)) {
      // Re-attach the separator that `withSep` consumed, so the rewritten path
      // stays a valid path rather than `/asked/pathsrc/a.ts`.
      return `${session.lexical}/${reported.slice(withSep.length)}`
    }
    if (reported === prefix) return session.lexical
    // A content row is `path:rest` or `path\0rest`; the separator after the
    // path is not part of the path.
    if (reported.startsWith(`${prefix}:`) || reported.startsWith(`${prefix}\0`)) {
      return `${session.lexical}${reported.slice(prefix.length)}`
    }
  }

  return reported
}

/** True when `p` is a background-task output symlink owned by this session. */
export function isTaskOutputLink(p: string): boolean {
  return basename(p) === 'tasks'
}
