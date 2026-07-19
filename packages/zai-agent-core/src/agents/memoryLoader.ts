import { readFile, readdir, stat } from 'fs/promises'
import { join, dirname, relative, sep } from 'path'
import { existsSync } from 'fs'
import ignore from 'ignore'

/**
 * zai-native slim memory loader.
 * Implements OpenCC's memory file system subset:
 * - Walks parent dirs up to .git boundary looking for AGENTS.md
 * - Loads .claude/rules/ recursive files
 * - Loads AGENTS.local.md (cwd only, not parent)
 * - Processes @include directives recursively (MAX_INCLUDE_DEPTH)
 * - Per-cwd module-level cache (clearMemoryCache() invalidates)
 * Best-effort contract: this module NEVER throws. Any error -> empty result.
 * Out of scope (future PRs):
 * - HTML comment stripping
 * - MAX_MEMORY_CHARACTER_COUNT truncation
 * - contentDiffersFromDisk tracking
 * - Symlink resolution, auto-memory, settings filters
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
const RULES_DIRNAME = join('.claude', 'rules')

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
    const visited = new Set<string>()

    // 1. Walk parent dirs for AGENTS.md (stops at .git boundary or filesystem root)
    const projectChain = await walkParentDirsForAgents(cwd)
    for (const projectPath of projectChain) {
      if (visited.has(projectPath)) continue
      visited.add(projectPath)
      const content = await readSafe(projectPath)
      if (content === null) continue
      const withIncludes = await processIncludes(content, projectPath, 0, visited)
      files.push({ path: projectPath, content: withIncludes, type: 'Project' })
    }

    // 2. AGENTS.local.md (cwd only, not parent)
    const localPath = join(cwd, AGENTS_LOCAL_FILENAME)
    if (!visited.has(localPath) && existsSync(localPath)) {
      const content = await readSafe(localPath)
      if (content !== null) {
        visited.add(localPath)
        const withIncludes = await processIncludes(content, localPath, 0, visited)
        files.push({ path: localPath, content: withIncludes, type: 'Local' })
      }
    }

    // 3. .claude/rules/**/*.md (recursive)
    const ig = ignore()
    const rules = await collectRulesDir(cwd, cwd, ig)
    files.push(...rules)

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
 * into the parent content. Cyclic includes are guarded by `visited`.
 */
async function processIncludes(
  content: string,
  parentPath: string,
  depth: number,
  visited: Set<string>,
): Promise<string> {
  if (depth >= MAX_INCLUDE_DEPTH) return content

  const lines = content.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const match = line.match(/^@(\S+)\s*$/)
    if (match) {
      const includeRel = match[1]
      const includeAbs = join(dirname(parentPath), includeRel)
      if (visited.has(includeAbs)) continue  // cycle guard
      if (!existsSync(includeAbs)) continue  // missing target → skip silently
      visited.add(includeAbs)
      const included = await readSafe(includeAbs)
      if (included !== null) {
        const recursed = await processIncludes(included, includeAbs, depth + 1, visited)
        out.push(`<!-- @include ${includeRel} -->\n${recursed}`)
      }
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

async function collectRulesDir(
  cwd: string,
  dir: string,
  ig: ReturnType<typeof ignore>,
): Promise<MemoryFile[]> {
  const result: MemoryFile[] = []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return result  // .claude/rules doesn't exist
  }

  for (const entry of entries) {
    const full = join(dir, entry)
    let st
    try {
      st = await stat(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      // Recurse into subdirectories of .claude/rules
      const sub = await collectRulesDir(cwd, full, ig)
      result.push(...sub)
    } else if (st.isFile() && entry.endsWith('.md')) {
      if (ig.ignores(relative(cwd, full))) continue
      const content = await readSafe(full)
      if (content === null) continue
      // Filter by frontmatter `paths:` glob if present.
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/)
      if (fmMatch) {
        const stripped = content.replace(/^---\n[\s\S]*?\n---\n/, '')
        result.push({ path: full, content: stripped, type: 'Rule' })
      } else {
        result.push({ path: full, content, type: 'Rule' })
      }
    }
  }
  return result
}
