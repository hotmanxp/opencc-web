import { readdir, readFile, realpath } from 'fs/promises'
import { dirname, isAbsolute, join, relative, sep as pathSep } from 'path'
import { basename } from 'path'
import { parseSkillFrontmatter } from './frontmatter.js'
import type { LoadedSkill, SkillFrontmatter } from './types.js'

const SKILL_FILENAME_RE = /^skill\.md$/i

export type LoadSkillsOptions = {
  cwd?: string
  homedirOverride?: string
}

export async function loadSkillsFromDirs(
  dirs: string[],
  _opts?: LoadSkillsOptions,
): Promise<LoadedSkill[]> {
  if (dirs.length === 0) return []

  const collected: Array<{ skill: LoadedSkill; fileId: string | null }> = []

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!
    const files = await walkDir(dir)
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
  return result
}

async function walkDir(basePath: string): Promise<string[]> {
  const results: string[] = []
  await walk(basePath, basePath, results, new Set())
  return results.sort()
}

async function walk(
  basePath: string,
  current: string,
  out: string[],
  visitedDirs: Set<string>,
): Promise<void> {
  const dirId = await safeRealpath(current)
  if (dirId && visitedDirs.has(dirId)) return
  if (dirId) visitedDirs.add(dirId)

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
  await Promise.all(childDirs.map(c => walk(basePath, c, out, visitedDirs)))
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

  const description = frontmatter.description?.trim() || extractFirstParagraph(body)
  if (!description) {
    console.warn(`[skills] ${filePath}: missing description, skipping`)
    return null
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
