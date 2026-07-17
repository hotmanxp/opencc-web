import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, join, relative, sep } from 'path'
import { parsePluginMarkdown } from './markdown.js'
import { resolvePluginPath } from '../manifest.js'
import { serializeError } from '../errors.js'
import type { LoadedPlugin, PluginSnapshot, PluginLoadError } from '../types.js'
import type { LoadedSkill, SkillFrontmatter } from '../../runtime/skills/types.js'

const SKILL_FILENAME_RE = /^skill\.md$/i
const SKILLS_STANDARD_DIR = 'skills'

type SkillsSourceRoot = {
  /** Relative path inside the plugin (e.g. `skills`, `extra-skills`). */
  relPath: string
  /** Absolute path on disk (realpath-resolved). */
  absRoot: string
}

/**
 * Load all SKILL.md entries for a plugin and append them to
 * `snapshot.skills`. Errors are collected on `snapshot.errors`.
 *
 * Sources:
 *   - `<root>/skills/<dir>/SKILL.md` (standard layout)
 *   - every directory listed in `manifest.skills` (string OR string[])
 *
 * Naming: each skill becomes `plugin:<pluginName>:<namespace>:<skillName>`
 * where `<namespace>` is the path of the skill's parent directory
 * relative to its source skills root, separated by `:`. A SKILL.md
 * directly under the skills root (no subdirectory) is ignored — same
 * shape as the existing `loadSkillsDir` behaviour.
 *
 * Failures (missing dirs, bad frontmatter, IO errors) are pushed to
 * `snapshot.errors` and never bubble out as exceptions.
 */
export async function loadPluginSkills(
  plugin: LoadedPlugin,
  snapshot: PluginSnapshot,
): Promise<void> {
  const pluginId = plugin.id
  const pluginName = plugin.manifest.name

  for (const sourceRoot of await resolveSkillsRoots(plugin, snapshot)) {
    let entries: import('fs').Dirent[]
    try {
      entries = await readdir(sourceRoot.absRoot, { withFileTypes: true })
    } catch (cause) {
      snapshot.errors.push({
        code: 'plugin_component_unreadable',
        message: `Failed to read plugin skills directory ${sourceRoot.absRoot}.`,
        component: 'skills',
        pluginId,
        path: sourceRoot.relPath,
        detail: serializeError(cause),
      })
      continue
    }

    for (const dirent of entries) {
      if (dirent.name.startsWith('.')) continue
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
      const dirAbs = join(sourceRoot.absRoot, dirent.name)
      const skillFile = await findSkillFile(dirAbs)
      if (!skillFile) continue

      const namespace = computeNamespace(dirAbs, sourceRoot.absRoot)
      await appendSkill({
        pluginName,
        pluginId,
        sourceRootRel: sourceRoot.relPath,
        filePath: skillFile,
        baseDir: dirAbs,
        namespace,
        snapshot,
      })
    }
  }
}

/**
 * Collect all source roots for skills: the standard `<root>/skills`
 * directory plus any extras declared in `manifest.skills`. Each declared
 * entry is funnelled through `resolvePluginPath` so a malicious manifest
 * cannot escape the plugin root; failures become structured errors on
 * `snapshot.errors`.
 */
async function resolveSkillsRoots(
  plugin: LoadedPlugin,
  snapshot: PluginSnapshot,
): Promise<SkillsSourceRoot[]> {
  const out: SkillsSourceRoot[] = []

  // Standard `<root>/skills`. May not exist; that's OK — we just skip
  // it without an error (matches existing `loadSkillsFromDirs`).
  const standardAbs = join(plugin.root, SKILLS_STANDARD_DIR)
  const standardStat = await stat(standardAbs).catch(() => null)
  if (standardStat && standardStat.isDirectory()) {
    out.push({ relPath: SKILLS_STANDARD_DIR, absRoot: standardAbs })
  }

  const declared = plugin.manifest.skills
  const declaredList: string[] = []
  if (typeof declared === 'string') {
    declaredList.push(declared)
  } else if (Array.isArray(declared)) {
    for (const item of declared) {
      if (typeof item === 'string') declaredList.push(item)
    }
  }

  for (const rel of declaredList) {
    let resolved: string
    try {
      resolved = await resolvePluginPath(plugin.root, rel, 'skills')
    } catch (cause) {
      snapshot.errors.push({
        code: 'plugin_path_outside_root',
        message: `Plugin skills path "${rel}" resolves outside the plugin root.`,
        component: 'skills',
        pluginId: plugin.id,
        path: rel,
        detail: serializeError(cause),
      })
      continue
    }
    const st = await stat(resolved).catch(() => null)
    if (!st || !st.isDirectory()) {
      snapshot.errors.push({
        code: 'plugin_component_missing',
        message: `Plugin skills directory "${rel}" is missing or not a directory.`,
        component: 'skills',
        pluginId: plugin.id,
        path: rel,
      })
      continue
    }
    out.push({ relPath: rel, absRoot: resolved })
  }

  return out
}

/**
 * Locate a SKILL.md inside `dirAbs` (case-insensitive). Returns the
 * absolute path or null when none exists.
 */
async function findSkillFile(dirAbs: string): Promise<string | null> {
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(dirAbs, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (e.isFile() && SKILL_FILENAME_RE.test(e.name)) {
      return join(dirAbs, e.name)
    }
  }
  return null
}

/**
 * Build the namespace component of a skill name. For `<root>/skills/a/b/c`,
 * `dirAbs` is `<root>/skills/a/b/c`, `absRoot` is `<root>/skills`,
 * the namespace is `a:b` (segments between the root and the immediate
 * parent of the SKILL.md directory's basename, which is `c`).
 */
function computeNamespace(dirAbs: string, absRoot: string): string {
  const rel = relative(absRoot, dirAbs)
  if (!rel || rel.startsWith('..') || rel === '.') return ''
  const parts = rel.split(sep).filter(Boolean)
  // Drop the last segment (the basename becomes the skillName).
  parts.pop()
  return parts.join(':')
}

type AppendSkillInput = {
  pluginName: string
  pluginId: string
  sourceRootRel: string
  filePath: string
  baseDir: string
  namespace: string
  snapshot: PluginSnapshot
}

async function appendSkill(input: AppendSkillInput): Promise<void> {
  const { pluginName, pluginId, sourceRootRel, filePath, baseDir, namespace, snapshot } = input

  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch (cause) {
    snapshot.errors.push({
      code: 'plugin_component_unreadable',
      message: `Failed to read plugin skill at ${filePath}.`,
      component: 'skills',
      pluginId,
      path: filePath,
      detail: serializeError(cause),
    })
    return
  }

  const parsed = parsePluginMarkdown(content, filePath)
  const frontmatter = parsed.frontmatter as SkillFrontmatter

  // Frontmatter parse failure → record and skip this file. Other
  // skills continue.
  if (parsed.error) {
    snapshot.errors.push({
      ...parsed.error,
      component: 'skills',
      pluginId,
    } satisfies PluginLoadError)
    return
  }

  const fmDescription =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''
  const description = fmDescription || extractFirstParagraph(parsed.body)
  if (!description) {
    snapshot.errors.push({
      code: 'plugin_skill_invalid',
      message: `Plugin skill ${filePath} has no description.`,
      component: 'skills',
      pluginId,
      path: filePath,
    })
    return
  }

  // Required: name. Falls back to the directory basename.
  const fmName = typeof frontmatter.name === 'string' ? frontmatter.name : ''
  const skillName = fmName || basename(baseDir)

  // Malformed frontmatter (starts with `---` but no closing terminator)
  // → body still begins with `---`. Treat as parse failure.
  if (Object.keys(frontmatter).length === 0 && parsed.body.trimStart().startsWith('---')) {
    snapshot.errors.push({
      code: 'plugin_markdown_parse_error',
      message: `Plugin skill ${filePath} has malformed frontmatter.`,
      component: 'skills',
      pluginId,
      path: filePath,
    })
    return
  }

  const exposedName = namespace
    ? `plugin:${pluginName}:${namespace}:${skillName}`
    : `plugin:${pluginName}:${skillName}`

  const skill: LoadedSkill = {
    name: exposedName,
    baseDir,
    filePath,
    frontmatter: { ...frontmatter, name: skillName, description },
    markdown: parsed.body,
    kind: 'skill',
    pluginId,
    source: 'plugin',
    description,
  }
  snapshot.skills.push(skill)

  // Avoid unused-var warnings.
  void sourceRootRel
}

/**
 * Extract the first non-empty paragraph from `body` for fallback
 * description. Mirrors the shape used in `loadSkillsDir`.
 */
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