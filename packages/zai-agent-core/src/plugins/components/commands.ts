import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, join, relative, sep } from 'path'
import { parsePluginMarkdown } from './markdown.js'
import { resolvePluginPath } from '../manifest.js'
import { serializeError } from '../errors.js'
import type { LoadedPlugin, PluginSnapshot, PluginLoadError } from '../types.js'
import type { LoadedSkill, SkillFrontmatter } from '../../runtime/skills/types.js'

const COMMAND_FILENAME_RE = /\.md$/i
const SKILL_FILENAME_RE = /^skill\.md$/i
const COMMANDS_STANDARD_DIR = 'commands'

/**
 * Load plugin commands and append them to `snapshot.skills` with
 * `kind: 'command'` (commands are surfaced through `SkillTool`).
 *
 * Source: every `*.md` directly inside `<root>/commands/`, plus any
 * `SKILL.md` inside `<root>/commands/<dir>/` subdirectories (matching
 * the OpenCC command layout). `manifest.commands` extra paths are also
 * accepted.
 *
 * Naming: `plugin:<pluginName>:<namespace>:<commandName>` where
 * `<namespace>` is the path of the command file relative to the
 * commands root, joined by `:`. The basename (without `.md`) becomes
 * `<commandName>`. Files in subdirectories get their directory
 * segments folded into `<namespace>`.
 *
 * Failures are pushed to `snapshot.errors` and never bubble out.
 */
export async function loadPluginCommands(
  plugin: LoadedPlugin,
  snapshot: PluginSnapshot,
): Promise<void> {
  const pluginId = plugin.id
  const pluginName = plugin.manifest.name

  // Walk every commands source root.
  const roots = await resolveCommandsRoots(plugin, snapshot)
  for (const sourceRoot of roots) {
    await walkCommandsRoot(sourceRoot, pluginName, pluginId, snapshot)
  }
}

type CommandsSourceRoot = {
  relPath: string
  absRoot: string
}

/**
 * Collect every commands source root. The standard `<root>/commands/`
 * is included when present; `manifest.commands` (string OR string[])
 * contributes additional roots, each funnelled through `resolvePluginPath`
 * so the boundary is enforced.
 */
async function resolveCommandsRoots(
  plugin: LoadedPlugin,
  snapshot: PluginSnapshot,
): Promise<CommandsSourceRoot[]> {
  const out: CommandsSourceRoot[] = []

  const standardAbs = join(plugin.root, COMMANDS_STANDARD_DIR)
  const standardStat = await stat(standardAbs).catch(() => null)
  if (standardStat && standardStat.isDirectory()) {
    out.push({ relPath: COMMANDS_STANDARD_DIR, absRoot: standardAbs })
  }

  const declared = plugin.manifest.commands
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
      resolved = await resolvePluginPath(plugin.root, rel, 'commands')
    } catch (cause) {
      snapshot.errors.push({
        code: 'plugin_path_outside_root',
        message: `Plugin commands path "${rel}" resolves outside the plugin root.`,
        component: 'commands',
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
        message: `Plugin commands directory "${rel}" is missing or not a directory.`,
        component: 'commands',
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
 * Walk a single commands root recursively and append every
 * command-shaped entry to the snapshot.
 *
 * Rules:
 *   - `*.md` files at any depth become one command each. The basename
 *     (without `.md`) is the commandName; the path segments between
 *     the source root and the file's parent become the namespace.
 *   - Directories containing a `SKILL.md` ALSO contribute a command
 *     named after the directory itself — but at the directory's own
 *     level (namespace empty), matching OpenCC's flat convention for
 *     `commands/<dir>/SKILL.md`. Subdirectories are still walked so
 *     deeper `*.md` files are picked up too.
 */
async function walkCommandsRoot(
  sourceRoot: CommandsSourceRoot,
  pluginName: string,
  pluginId: string,
  snapshot: PluginSnapshot,
): Promise<void> {
  await walkCommandsDir({
    absDir: sourceRoot.absRoot,
    sourceRoot,
    pluginName,
    pluginId,
    snapshot,
  })
}

async function walkCommandsDir(input: {
  absDir: string
  sourceRoot: CommandsSourceRoot
  pluginName: string
  pluginId: string
  snapshot: PluginSnapshot
}): Promise<void> {
  const { absDir, sourceRoot, pluginName, pluginId, snapshot } = input
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch (cause) {
    snapshot.errors.push({
      code: 'plugin_component_unreadable',
      message: `Failed to read plugin commands directory ${absDir}.`,
      component: 'commands',
      pluginId,
      path: sourceRoot.relPath,
      detail: serializeError(cause),
    })
    return
  }

  for (const dirent of entries) {
    if (dirent.name.startsWith('.')) continue
    const entryPath = join(absDir, dirent.name)

    if (dirent.isFile() && COMMAND_FILENAME_RE.test(dirent.name)) {
      const commandName = basename(dirent.name, '.md')
      await appendCommand({
        pluginName,
        pluginId,
        filePath: entryPath,
        sourceRoot,
        parentAbs: absDir,
        commandName,
        snapshot,
      })
      continue
    }

    if (dirent.isDirectory() || dirent.isSymbolicLink()) {
      // `<root>/commands/<dir>/SKILL.md` is treated as a flat command
      // named after the directory.
      const skillFile = await findSkillFile(entryPath)
      if (skillFile) {
        await appendCommand({
          pluginName,
          pluginId,
          filePath: skillFile,
          sourceRoot,
          parentAbs: sourceRoot.absRoot,
          commandName: dirent.name,
          snapshot,
        })
      }
      // Recurse into the directory so nested `*.md` files still load.
      await walkCommandsDir({
        absDir: entryPath,
        sourceRoot,
        pluginName,
        pluginId,
        snapshot,
      })
    }
  }
}

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

type AppendCommandInput = {
  pluginName: string
  pluginId: string
  filePath: string
  /** Absolute path of the source root (e.g. `<root>/commands`). */
  sourceRoot: CommandsSourceRoot
  /**
   * Absolute path of the directory that directly contains the command
   * (either the source root for top-level files, or a subdirectory for
   * `<dir>/SKILL.md`).
   */
  parentAbs: string
  commandName: string
  snapshot: PluginSnapshot
}

async function appendCommand(input: AppendCommandInput): Promise<void> {
  const {
    pluginName,
    pluginId,
    filePath,
    sourceRoot,
    parentAbs,
    commandName,
    snapshot,
  } = input

  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch (cause) {
    snapshot.errors.push({
      code: 'plugin_component_unreadable',
      message: `Failed to read plugin command at ${filePath}.`,
      component: 'commands',
      pluginId,
      path: filePath,
      detail: serializeError(cause),
    })
    return
  }

  const parsed = parsePluginMarkdown(content, filePath)
  if (parsed.error) {
    snapshot.errors.push({
      ...parsed.error,
      component: 'commands',
      pluginId,
    } satisfies PluginLoadError)
    return
  }

  const frontmatter = parsed.frontmatter as SkillFrontmatter
  const fmDescription =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''
  const description = fmDescription || extractFirstParagraph(parsed.body)
  if (!description) {
    snapshot.errors.push({
      code: 'plugin_command_invalid',
      message: `Plugin command ${filePath} has no description.`,
      component: 'commands',
      pluginId,
      path: filePath,
    })
    return
  }

  // Namespace = path of `parentAbs` relative to the source root, joined by `:`.
  // For top-level files parentAbs === sourceRoot.absRoot → empty namespace.
  // For `commands/build/foo/SKILL.md`, parentAbs = `.../build/foo`, namespace = `build:foo`.
  const nsRel = relative(sourceRoot.absRoot, parentAbs)
  const namespace =
    nsRel && nsRel !== '.' && !nsRel.startsWith('..')
      ? nsRel.split(sep).filter(Boolean).join(':')
      : ''

  const exposedName = namespace
    ? `plugin:${pluginName}:${namespace}:${commandName}`
    : `plugin:${pluginName}:${commandName}`

  const skill: LoadedSkill = {
    name: exposedName,
    baseDir: dirname(filePath),
    filePath,
    frontmatter: { ...frontmatter, name: commandName, description },
    markdown: parsed.body,
    kind: 'command',
    pluginId,
    source: 'plugin',
    description,
  }
  snapshot.skills.push(skill)
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