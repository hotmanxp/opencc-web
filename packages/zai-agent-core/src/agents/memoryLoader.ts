import { readFile } from 'fs/promises'
import { join, dirname, relative, sep } from 'path'
import { existsSync } from 'fs'

/**
 * zai-native slim memory loader.
 * Implements OpenCC's memory file system subset:
 * - Walks parent dirs up to .git boundary looking for AGENTS.md
 * - Loads AGENTS.local.md (cwd only, not parent)
 * - Processes @include directives recursively (MAX_INCLUDE_DEPTH)
 * - Per-cwd module-level cache (clearMemoryCache() invalidates)
 * Best-effort contract: this module NEVER throws. Any error -> empty result.
 * Out of scope (future PRs):
 * - HTML comment stripping
 * - MAX_MEMORY_CHARACTER_COUNT truncation
 * - contentDiffersFromDisk tracking
 * - Symlink resolution, auto-memory, settings filters
 * - `.claude/rules` recursive load (intentionally not implemented —
 *   loading the whole cwd subtree produced 100+ MB system prompts when
 *   cwd contained node_modules / .worktrees / .git. Add it back via a
 *   separate path with an explicit allowlist if needed.)
 */

export type MemoryType = 'Project' | 'Local' | 'Rule'

export interface MemoryFile {
  path: string
  content: string
  type: MemoryType
  /** Path of the file that included this one, for @include traceability. */
  parent?: string
}

export const MAX_INCLUDE_DEPTH = 5

const AGENTS_FILENAME = 'AGENTS.md'
const AGENTS_LOCAL_FILENAME = 'AGENTS.local.md'

// Per-cwd cache. Key: absolute cwd path. Value: ordered list of memory files.
const cache = new Map<string, MemoryFile[]>()

/**
 * Load all memory files for a given cwd.
 * Never throws. Returns [] on any error.
 */
export async function loadMemoryForPrompt(cwd: string): Promise<MemoryFile[]> {
  try {
    const cached = cache.get(cwd)
    if (cached) return cached

    const files: MemoryFile[] = []
    // Two tracking sets:
    // - `topLevel`: absolute paths of files already pushed as a top-level
    //   MemoryFile entry. Used to dedup top-level entrypoints (AGENTS.md
    //   at the same path is the same file).
    // - `includedAnywhere`: absolute paths that have appeared in any @include
    //   chain. Used purely for cycle detection (A includes B, B includes A
    //   → B's recursion sees A is in the chain, aborts). Crucially this is
    //   NOT used to dedup "second include of the same path from a different
    //   top-level" — each top-level file passes its OWN chain down so two
    //   unrelated top-level files can include the same path without one
    //   silently dropping it. The OpenCC vendored behaviour is "include
    //   once per source tree", not "include once globally".
    const topLevel = new Set<string>()

    // 1. Walk parent dirs for AGENTS.md (stops at .git boundary or filesystem root)
    const projectChain = await walkParentDirsForAgents(cwd)
    for (const projectPath of projectChain) {
      if (topLevel.has(projectPath)) continue
      topLevel.add(projectPath)
      const content = await readSafe(projectPath)
      if (content === null) continue
      const chain = new Set<string>(topLevel)
      const withIncludes = await processIncludes(content, projectPath, 0, chain)
      files.push({ path: projectPath, content: withIncludes, type: 'Project' })
    }

    // 2. AGENTS.local.md (cwd only, not parent)
    const localPath = join(cwd, AGENTS_LOCAL_FILENAME)
    if (!topLevel.has(localPath) && existsSync(localPath)) {
      const content = await readSafe(localPath)
      if (content !== null) {
        topLevel.add(localPath)
        const chain = new Set<string>(topLevel)
        const withIncludes = await processIncludes(content, localPath, 0, chain)
        files.push({ path: localPath, content: withIncludes, type: 'Local' })
      }
    }

    // (Step 3 — .claude/rules/**/*.md recursive load — intentionally not
    // implemented. See file-header comment for why.)

    cache.set(cwd, files)
    return files
  } catch (err) {
    console.debug('[memory] loadMemoryForPrompt failed:', err)
    return []
  }
}

/**
 * Clear the per-cwd cache so the next call re-reads from disk.
 */
export function clearMemoryCache(): void {
  cache.clear()
}

/**
 * Check if any @include target is outside the given cwd.
 * Used for warning the user at server start.
 */
export async function hasExternalIncludes(cwd: string): Promise<boolean> {
  try {
    const files = await loadMemoryForPrompt(cwd)
    for (const f of files) {
      if (f.parent) {
        // Has a parent → was @include'd. Check if parent is outside cwd.
        const relParent = relative(cwd, f.parent)
        if (relParent === '..' || relParent.startsWith('..' + sep)) return true
      }
    }
    return false
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function walkParentDirsForAgents(startCwd: string): Promise<string[]> {
  const result: string[] = []
  let dir = startCwd
  let iterations = 0
  const MAX_DEPTH = 50  // safety: prevent infinite loop on weird fs configs

  while (iterations++ < MAX_DEPTH) {
    const candidate = join(dir, AGENTS_FILENAME)
    if (existsSync(candidate)) {
      result.push(candidate)
    }
    // Stop at .git boundary
    if (existsSync(join(dir, '.git'))) break

    const parent = dirname(dir)
    if (parent === dir) break  // reached filesystem root
    dir = parent
  }

  return result.reverse()  // root → leaf order
}

async function readSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Recursively process @include directives. Each include is inlined
 * into the parent content. Cyclic includes are guarded by `chain` — a
 * file appears at most once per top-level expansion tree. Two top-level
 * files can independently include the same path without dropping one.
 */
async function processIncludes(
  content: string,
  parentPath: string,
  depth: number,
  chain: Set<string>,
): Promise<string> {
  if (depth >= MAX_INCLUDE_DEPTH) return content

  const lines = content.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const match = line.match(/^@(\S+)\s*$/)
    if (match) {
      const includeRel = match[1]
      const includeAbs = join(dirname(parentPath), includeRel)
      if (chain.has(includeAbs)) continue  // cycle guard (current chain)
      if (!existsSync(includeAbs)) continue  // missing target → skip silently
      chain.add(includeAbs)
      const included = await readSafe(includeAbs)
      if (included !== null) {
        const recursed = await processIncludes(included, includeAbs, depth + 1, chain)
        out.push(`<!-- @include ${includeRel} -->\n${recursed}`)
      }
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}
