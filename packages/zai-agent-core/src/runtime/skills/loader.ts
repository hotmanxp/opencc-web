import { readdir, readFile, realpath } from 'fs/promises'
import ignore from 'ignore'
import { dirname, isAbsolute, join, relative, sep as pathSep } from 'path'
import { basename } from 'path'
import {
  coerceDescriptionToString,
  parseBooleanFrontmatter,
  parseShellFrontmatter,
  parseSkillFrontmatter,
  splitPathInFrontmatter,
} from './frontmatter.js'
import type { LoadedSkill, SkillFrontmatter } from './types.js'

const SKILL_FILENAME_RE = /^skill\.md$/i

export type LoadSkillsOptions = {
  cwd?: string
  homedirOverride?: string
  /**
   * Optional callback that decides whether a given directory should be loaded.
   * Returning false blocks the directory (used to skip gitignored paths like
   * `node_modules/pkg/.claude/skills`). Defaults to "always allow".
   */
  isDirGitignored?: (dir: string) => Promise<boolean>
}

/**
 * A skill that loaded successfully but should NOT be exposed to the model
 * until one of its `paths:` patterns matches a file being edited. Mirrors
 * opencc's conditional-skills mechanism (matches AGENTS.md conditional rules).
 *
 * Callers (read/edit/write tools) call `activateConditionalSkillsForPaths`
 * with the files they're operating on; matched skills then surface in the
 * skill listing for the rest of the session.
 */
export type ConditionalSkill = LoadedSkill & {
  /** Path patterns from the frontmatter. */
  paths: string[]
}

export type LoadSkillsResult = {
  /**
   * Skills surfaced to the model unconditionally. Includes both unconditional
   * skills (no `paths:`) and conditional skills that have already been
   * activated this session.
   */
  unconditional: LoadedSkill[]
  /**
   * Conditional skills that are loaded but not yet surfaced. Callers should
   * call `activateConditionalSkillsForPaths` to promote them as the user
   * edits matching files.
   */
  conditional: ConditionalSkill[]
}

export async function loadSkillsFromDirs(
  dirs: string[],
  opts?: LoadSkillsOptions,
): Promise<LoadedSkill[]> {
  const result = await loadSkillsFromDirsDetailed(dirs, opts)
  return result.unconditional
}

/**
 * Detailed loader — returns both unconditional and conditional skills so
 * callers that want to wire up path-based activation (e.g. Read/Edit/Write
 * tools) can do so without re-walking the directory tree.
 */
export async function loadSkillsFromDirsDetailed(
  dirs: string[],
  opts?: LoadSkillsOptions,
): Promise<LoadSkillsResult> {
  if (dirs.length === 0) return { unconditional: [], conditional: [] }

  const collected: Array<{ skill: LoadedSkill; fileId: string | null }> = []

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!
    const files = await walkDir(dir, opts)
    for (const file of files) {
      try {
        const skill = await parseSkillFile(file, dir, i)
        if (!skill) continue
        const fileId = await safeRealpath(file)
        collected.push({ skill, fileId })
      } catch (err) {
        console.warn(`[skills] failed to load ${file}:`, err)
      }
    }
  }

  const seen = new Set<string>()
  const result: LoadedSkill[] = []
  for (const { skill, fileId } of collected) {
    if (fileId && seen.has(fileId)) continue
    if (fileId) seen.add(fileId)
    result.push(skill)
  }

  // Partition into unconditional + conditional. Unconditional skills are
  // surfaced immediately; conditional ones stay hidden until path-matched.
  const unconditional: LoadedSkill[] = []
  const conditional: ConditionalSkill[] = []
  for (const skill of result) {
    const paths = splitPathInFrontmatter(skill.frontmatter?.paths)
    if (paths.length > 0) {
      conditional.push({ ...skill, paths })
    } else {
      unconditional.push(skill)
    }
  }
  return { unconditional, conditional }
}

/**
 * Test whether any of a conditional skill's `paths:` patterns match one of
 * the given absolute file paths. Returns the activated skill names.
 *
 * Uses the `ignore` library for gitignore-style pattern matching (the same
 * library AGENTS.md conditional rules use). Paths outside `cwd` are skipped
 * — they can't match cwd-relative patterns anyway.
 */
export function activateConditionalSkillsForPaths(
  conditional: ConditionalSkill[],
  filePaths: string[],
  cwd: string,
): ConditionalSkill[] {
  if (conditional.length === 0 || filePaths.length === 0) return []

  const resolvedCwd = cwd.endsWith(pathSep) ? cwd.slice(0, -1) : cwd
  const activated: ConditionalSkill[] = []

  for (const skill of conditional) {
    const ig = ignore().add(skill.paths)
    for (const fp of filePaths) {
      const rel = isAbsolute(fp) ? relative(resolvedCwd, fp) : fp
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
      if (ig.ignores(rel)) {
        activated.push(skill)
        break
      }
    }
  }
  return activated
}

async function walkDir(
  basePath: string,
  opts?: LoadSkillsOptions,
): Promise<string[]> {
  const results: string[] = []
  await walk(basePath, basePath, results, new Set(), opts)
  return results.sort()
}

async function walk(
  basePath: string,
  current: string,
  out: string[],
  visitedDirs: Set<string>,
  opts?: LoadSkillsOptions,
): Promise<void> {
  const dirId = await safeRealpath(current)
  if (dirId && visitedDirs.has(dirId)) return
  if (dirId) visitedDirs.add(dirId)

  // Optional gitignore gate. Default behavior is permissive (load everything);
  // callers wire this in for safety against `node_modules/.../.claude/skills`
  // style bloat. Mirrors opencc's `isPathGitignored` wiring.
  if (opts?.isDirGitignored && dirId && (await opts.isDirGitignored(dirId))) {
    return
  }

  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    return
  }

  const childDirs: string[] = []
  for (const entry of entries) {
    const entryPath = join(current, entry.name)
    if (SKILL_FILENAME_RE.test(entry.name)) {
      out.push(entryPath)
    } else if (entry.isDirectory()) {
      childDirs.push(entryPath)
    } else if (entry.isSymbolicLink()) {
      try {
        const { stat } = await import('fs/promises')
        const s = await stat(entryPath)
        if (s.isDirectory()) childDirs.push(entryPath)
      } catch {
        // dangling symlink, skip
      }
    }
  }
  await Promise.all(childDirs.map(c => walk(basePath, c, out, visitedDirs, opts)))
}

async function parseSkillFile(
  filePath: string,
  basePath: string,
  sourceIndex: number,
): Promise<LoadedSkill | null> {
  const content = await readFile(filePath, 'utf-8')
  // Frontmatter parse failure (bad YAML, invalid key shape, etc.) must not
  // bubble out of this function — a single malformed skill file should skip
  // itself rather than abort the whole loadSkillsFromDirs walk. The caller
  // still has a defensive try/catch, but keeping the boundary local makes the
  // contract explicit (LoadedSkill | null, never throws on bad input).
  let frontmatter: SkillFrontmatter
  let body: string
  try {
    ;({ frontmatter, body } = parseSkillFrontmatter(content, filePath))
  } catch (err) {
    console.warn(
      `[skills] ${filePath}: frontmatter parse failed, skipping —`,
      err instanceof Error ? err.message : err,
    )
    return null
  }

  // malformed frontmatter (starts with `---` but has no closing terminator)
  // produces empty frontmatter + body starting with `---`. Treat as parse failure.
  if (Object.keys(frontmatter).length === 0 && body.trimStart().startsWith('---')) {
    console.warn(`[skills] ${filePath}: malformed frontmatter, skipping`)
    return null
  }

  // Coerce description. YAML may parse unquoted `description: yes` as boolean.
  // Fall back to the first paragraph of the body if no string description.
  const coercedDesc = coerceDescriptionToString(frontmatter.description, filePath)
  const description = coercedDesc ?? extractFirstParagraph(body)
  if (!description) {
    console.warn(`[skills] ${filePath}: missing description, skipping`)
    return null
  }

  // Skip skills with user-invocable: false. Mirrors opencc: these are
  // "background" skills meant to be invoked programmatically, not surfaced
  // to the model. They're still loaded from disk so callers can still use
  // them by direct name.
  const userInvocable = parseBooleanFrontmatter(frontmatter['user-invocable'], true)
  if (!userInvocable) {
    console.warn(`[skills] ${filePath}: user-invocable=false, skipping`)
    return null
  }

  // Validate `shell:` frontmatter if present — invalid shapes are silently
  // dropped (loader doesn't fail the whole walk on one bad skill).
  if (frontmatter.shell !== undefined) {
    const parsedShell = parseShellFrontmatter(frontmatter.shell, filePath)
    if (!parsedShell) {
      console.warn(
        `[skills] ${filePath}: invalid shell frontmatter, ignoring`,
      )
      // Strip so downstream code doesn't try to reparse.
      delete frontmatter.shell
    }
  }

  // Strip frontmatter shape cruft before storing so downstream consumers see
  // a stable shape regardless of how YAML parsed it.
  if (typeof frontmatter.description === 'object') {
    frontmatter.description = description
  }

  const skillDir = dirname(filePath)

  // root-level SKILL.md (skillDir === basePath) is not a skill entry — skip
  if (pathsEqual(skillDir, basePath)) {
    console.warn(`[skills] ${filePath}: SKILL.md directly in skills dir, skipping`)
    return null
  }

  const name = buildName(skillDir, basePath)
  const normalizedFm: SkillFrontmatter = { ...frontmatter, description }

  return {
    name,
    baseDir: skillDir,
    filePath,
    frontmatter: normalizedFm,
    markdown: body,
    sourceIndex,
    description,
  }
}

function pathsEqual(a: string, b: string): boolean {
  const na = a.endsWith(pathSep) ? a.slice(0, -1) : a
  const nb = b.endsWith(pathSep) ? b.slice(0, -1) : b
  return na === nb
}

function buildName(skillDir: string, basePath: string): string {
  const baseName = basename(skillDir)
  const namespace = buildNamespace(skillDir, basePath)
  return namespace ? `${namespace}:${baseName}` : baseName
}

function buildNamespace(targetDir: string, baseDir: string): string {
  const normalizedBase = baseDir.endsWith(pathSep) ? baseDir.slice(0, -1) : baseDir
  if (pathsEqual(targetDir, normalizedBase)) return ''
  const prefix = normalizedBase + pathSep
  if (!targetDir.startsWith(prefix)) return ''
  const rel = targetDir.slice(prefix.length)
  // namespace = path segments between basePath and skillDir (excluding baseName itself)
  const parts = rel.split(pathSep)
  parts.pop()
  return parts.join(':')
}

function extractFirstParagraph(body: string): string {
  const lines = body.split(/\r?\n/)
  const buf: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) {
      if (buf.length > 0) break
      continue
    }
    buf.push(t.replace(/^#+\s*/, ''))
  }
  return buf.join(' ')
}

async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p)
  } catch {
    return null
  }
}