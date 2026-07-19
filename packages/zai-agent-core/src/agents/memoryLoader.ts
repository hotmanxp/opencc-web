import { readFile, readdir, stat } from 'fs/promises'
import { join, dirname, relative, sep } from 'path'
import { existsSync } from 'fs'
import ignore from 'ignore'
import picomatch from 'picomatch'

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
 * Parse a YAML frontmatter block (the content between the two `---` fences)
 * into a list of glob patterns from the `paths:` key. Supports both YAML
 * list syntax (`paths: [a, b]`) and comma-separated scalar (`paths: a, b`),
 * matching OpenCC's vendored behaviour. Returns [] when `paths:` is missing
 * or contains only `**` (match-all = include unconditionally).
 */
function parseFrontmatterPaths(fmBlock: string): string[] {
  const m = fmBlock.match(/^paths:\s*(.+?)\s*$/m)
  if (!m) return []
  const raw = m[1]
  // Strip inline YAML list brackets if present
  const inner = raw.replace(/^\[/, '').replace(/\]$/, '').trim()
  if (!inner) return []
  const parts = inner
    .split(',')
    .map((p) => p.trim().replace(/^["']|["']$/g, ''))
    .filter((p) => p.length > 0)
  // Drop `/**` suffix — picomatch `src` matches both the dir and contents.
  const cleaned = parts.map((p) => (p.endsWith('/**') ? p.slice(0, -3) : p))
  // All `**` (match-all) → treat as no gate
  if (cleaned.length === 0 || cleaned.every((p) => p === '**')) return []
  return cleaned
}

/**
 * Decide whether a `paths:` frontmatter gate is satisfied for unconditional
 * prompt load. The vendored OpenCC semantics (per
 * opencc-internals/utils/claudemd.ts:255-411 + the consumer at runtime):
 * a rule with `paths: ["src/**"]` applies when the active context file is
 * under `src/`. For session-start load there's no active file, so we
 * approximate by checking whether cwd contains at least one top-level
 * entry whose name matches any pattern (after stripping a trailing `/**`).
 * An empty pattern list is treated as "no gate" (return true).
 */
async function matchesCwdTree(cwd: string, patterns: string[]): Promise<boolean> {
  if (patterns.length === 0) return true
  let entries: string[]
  try {
    entries = await readdir(cwd)
  } catch {
    return true  // can't enumerate → don't filter (fail-open)
  }
  for (const pat of patterns) {
    for (const entry of entries) {
      // picomatch handles both literal patterns (`src`) and globs (`*.ts`).
      // `dot: true` lets `.foo` match if the pattern explicitly targets it.
      if (picomatch.isMatch(entry, pat, { dot: true })) return true
    }
  }
  return false
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
    let st: Awaited<ReturnType<typeof stat>>
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
      const relPath = relative(cwd, full)
      if (ig.ignores(relPath)) continue
      const content = await readSafe(full)
      if (content === null) continue
      // Parse frontmatter. Vendored OpenCC semantics (opencc-internals/
      // utils/claudemd.ts:255-280 + 351-411):
      //   - `paths:` is a YAML list (or comma-separated string) of globs.
      //   - A rule with `paths:` applies only when the relevant context
      //     (the active file path, or in unconditional-load mode the cwd
      //     tree) matches one of the patterns.
      //   - A rule with NO `paths:` (or with a `**` / match-all pattern)
      //     applies unconditionally.
      // We implement the unconditional-load gate: when no specific file
      // is active, the rule is INCLUDED iff cwd's relative tree contains
      // at least one path matching the frontmatter `paths:` patterns.
      // Concretely: pattern `src/**` includes the rule when cwd contains
      // a `src/` directory; pattern `**` (match-all) means include; empty
      // / missing `paths:` means include.
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/)
      let stripped = content
      if (fmMatch) {
        const fmBlock = fmMatch[1]
        const patterns = parseFrontmatterPaths(fmBlock)
        if (!(await matchesCwdTree(cwd, patterns))) continue  // paths: gate skipped
        stripped = content.replace(/^---\n[\s\S]*?\n---\n/, '')
      }
      result.push({ path: full, content: stripped, type: 'Rule' })
    }
  }
  return result
}
