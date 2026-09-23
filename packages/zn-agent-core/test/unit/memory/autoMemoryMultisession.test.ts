/**
 * zai patch (2026-09-23): regression coverage for the multi-session
 * auto-memory backport.
 *
 * Before this change `getAutoMemPath()` was memoized on `getProjectRoot()`,
 * a value fixed at process start, so every session in a zai process shared
 * one memory directory and a session whose cwd sat in a different repo could
 * read and write another project's memory. Resolution now reads the
 * session-scoped `SdkContext.memoryCwd`.
 *
 * See docs/superpowers/specs/2026-09-23-zai-auto-memory-multisession-design.md
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { runWithSdkContext } from '../../../src/opencc-src/bootstrap/state.js'
import {
  getAutoMemEntrypoint,
  getAutoMemPath,
  getMemoryBaseDir,
  isExtractModeActive,
  resolveMemCwd,
} from '../../../src/opencc-src/memdir/paths.js'
import { isTeamMemoryEnabled } from '../../../src/opencc-src/memdir/teamMemPaths.js'

/**
 * Run `fn` inside a query-scoped ALS context, the way
 * createOpenccRuntime-impl.ts does for each session.
 */
function inSession<T>(memoryCwd: string, fn: () => T): T {
  return runWithSdkContext(
    {
      sessionId: `sess-${memoryCwd}`,
      sessionProjectDir: null,
      // Deliberately constant: this mirrors zai, where `cwd` is the
      // runtime-instance cwd shared by every session, while only memoryCwd
      // varies per session.
      cwd: '/instance/cwd',
      originalCwd: '/instance/cwd',
      memoryCwd,
    } as never,
    fn,
  )
}

const REPO_ROOT = path.resolve(process.cwd(), '../..')
const hasGitRoot = existsSync(path.join(REPO_ROOT, '.git'))

describe('auto-memory path resolution is session-scoped', () => {
  it('resolves the directory from the session cwd', () => {
    expect(inSession('/x/repo-a', resolveMemCwd)).toBe('/x/repo-a')
    expect(inSession('/x/repo-b', resolveMemCwd)).toBe('/x/repo-b')
  })

  it('falls back to the project root outside a query context', () => {
    expect(resolveMemCwd()).not.toBe('')
  })

  it('gives two sessions in different repos different directories', () => {
    const a = inSession('/x/repo-a', getAutoMemPath)
    const b = inSession('/x/repo-b', getAutoMemPath)

    expect(a).not.toBe(b)
    // Both stay under the shared zai config home.
    expect(a.startsWith(getMemoryBaseDir())).toBe(true)
    expect(b.startsWith(getMemoryBaseDir())).toBe(true)
  })

  it('does not leak one session directory into the next', () => {
    // Interleave two contexts: with the old process-wide memoize the second
    // read returned the first session's directory.
    const first = inSession('/x/repo-a', getAutoMemPath)
    const second = inSession('/x/repo-b', getAutoMemPath)
    const firstAgain = inSession('/x/repo-a', getAutoMemPath)

    expect(first).toBe(firstAgain)
    expect(second).not.toBe(first)
  })

  it('points the entrypoint at MEMORY.md inside the session directory', () => {
    const dir = inSession('/x/repo-a', getAutoMemPath)
    expect(inSession('/x/repo-a', getAutoMemEntrypoint)).toBe(
      path.join(dir, 'MEMORY.md'),
    )
  })

  it.runIf(hasGitRoot)(
    'shares one directory across subdirectories of the same git root',
    () => {
      // "one memory per project" must survive the per-session lookup: a
      // session that cwd'd into a subdirectory still resolves to its repo's
      // canonical git root.
      const root = inSession(REPO_ROOT, getAutoMemPath)
      const sub = inSession(path.join(REPO_ROOT, 'packages'), getAutoMemPath)
      expect(sub).toBe(root)
    },
  )

  it('treats two never-canonicalised cwds as distinct', () => {
    // Guards the memoize key: it must be the resolving cwd, not projectRoot.
    expect(inSession('/nonexistent/one', getAutoMemPath)).not.toBe(
      inSession('/nonexistent/two', getAutoMemPath),
    )
  })
})

describe('team memory is hard-disabled in zai', () => {
  it('reports team memory as disabled', () => {
    expect(isTeamMemoryEnabled()).toBe(false)
  })
})

describe('extraction gate follows zai consent, not GrowthBook', () => {
  it('is inactive when auto-memory is disabled by env', () => {
    const prev = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
    try {
      expect(isExtractModeActive()).toBe(false)
    } finally {
      if (prev === undefined) {
        delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
      } else {
        process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = prev
      }
    }
  })
})