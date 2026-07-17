import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, join, relative, sep } from 'path'
import { parsePluginMarkdown } from './markdown.js'
import { resolvePluginPath } from '../manifest.js'
import { serializeError } from '../errors.js'
import type { LoadedPlugin, PluginSnapshot, PluginLoadError } from '../types.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'

const AGENT_FILENAME_RE = /\.md$/i
const AGENTS_STANDARD_DIR = 'agents'

const PLUGIN_ROOT_TOKEN = '${CLAUDE_PLUGIN_ROOT}'

/**
 * Frontmatter keys that are explicitly ignored on plugin agents per the
 * OpenCC review safety boundary (PR #22558 comment). These fields are
 * not part of `AgentDefinition` and would create unintended trust
 * elevation if accepted silently.
 */
const IGNORED_AGENT_FRONTMATTER_KEYS = [
  'permissionMode',
  'hooks',
  'mcpServers',
] as const

/**
 * Load plugin agents and append them to `snapshot.agents` as
 * `AgentDefinition`s. Naming:
 * `plugin:<pluginName>:<namespace>:<agentName>` where `<agentName>` is
 * the frontmatter `name` and `<namespace>` is the path segments between
 * the loader's source root and the directory holding the agent file
 * (joined by `:`). The empty namespace case collapses to
 * `plugin:<pluginName>:<agentName>` (matching the existing skill/command
 * naming convention).
 *
 * Sources:
 *   - `<root>/agents/<file>.md` (standard layout)
 *   - `manifest.agents` extra paths (string OR string[]) of `.md` files
 *     OR directories containing `.md` files
 *
 * `permissionMode`, `hooks`, and `mcpServers` inside plugin agent
 * frontmatter are recorded as debug warnings on `snapshot.errors` and
 * discarded before constructing the `AgentDefinition`.
 *
 * Failures are pushed to `snapshot.errors`; this function never throws.
 */
export async function loadPluginAgents(
  plugin: LoadedPlugin,
  snapshot: PluginSnapshot,
): Promise<void> {
  const pluginId = plugin.id
  const pluginName = plugin.manifest.name
  const pluginRoot = plugin.root

  // Standard layout: <root>/agents/*.md
  const standardDir = join(plugin.root, AGENTS_STANDARD_DIR)
  const standardStat = await stat(standardDir).catch(() => null)
  if (standardStat && standardStat.isDirectory()) {
    await walkAgentsDir({
      absRoot: standardDir,
      sourceRootAbs: standardDir,
      relPath: AGENTS_STANDARD_DIR,
      pluginName,
      pluginId,
      pluginRoot,
      snapshot,
    })
  }

  // Manifest extras.
  const declared = plugin.manifest.agents
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
      resolved = await resolvePluginPath(plugin.root, rel, 'agents')
    } catch (cause) {
      snapshot.errors.push({
        code: 'plugin_path_outside_root',
        message: `Plugin agents path "${rel}" resolves outside the plugin root.`,
        component: 'agents',
        pluginId,
        path: rel,
        detail: serializeError(cause),
      })
      continue
    }
    const st = await stat(resolved).catch(() => null)
    if (!st) {
      snapshot.errors.push({
        code: 'plugin_component_missing',
        message: `Plugin agents entry "${rel}" is missing.`,
        component: 'agents',
        pluginId,
        path: rel,
      })
      continue
    }
    if (st.isFile() && AGENT_FILENAME_RE.test(resolved)) {
      // Single-file declaration: agent is the file itself, namespace
      // comes from the directory part of `rel` (excluding the basename).
      await appendAgent({
        pluginName,
        pluginId,
        pluginRoot,
        filePath: resolved,
        // For a manifest.agents path like `extra/agent.md`, the source
        // root for namespace calculation is the directory portion of
        // the path (`extra/`). Namespace segments are those *between*
        // the source root and the file's parent (here, none).
        namespaceSegments: [],
        snapshot,
      })
      continue
    }
    if (st.isDirectory()) {
      await walkAgentsDir({
        absRoot: resolved,
        sourceRootAbs: resolved,
        relPath: rel,
        pluginName,
        pluginId,
        pluginRoot,
        snapshot,
      })
    }
  }
}

type WalkAgentsDirInput = {
  absRoot: string
  sourceRootAbs: string
  relPath: string
  pluginName: string
  pluginId: string
  pluginRoot: string
  snapshot: PluginSnapshot
}

/**
 * Walk an agents directory and append each `*.md` file. Top-level only —
 * agents are not deeply nested in the standard layout. The namespace
 * segments come from `relative(sourceRootAbs, filePath)`.
 */
async function walkAgentsDir(input: WalkAgentsDirInput): Promise<void> {
  const { absRoot, sourceRootAbs, relPath, pluginName, pluginId, pluginRoot, snapshot } = input
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(absRoot, { withFileTypes: true })
  } catch (cause) {
    snapshot.errors.push({
      code: 'plugin_component_unreadable',
      message: `Failed to read plugin agents directory ${absRoot}.`,
      component: 'agents',
      pluginId,
      path: relPath,
      detail: serializeError(cause),
    })
    return
  }

  for (const dirent of entries) {
    if (dirent.name.startsWith('.')) continue
    if (!dirent.isFile() && !dirent.isSymbolicLink()) continue
    if (!AGENT_FILENAME_RE.test(dirent.name)) continue
    const filePath = join(absRoot, dirent.name)
    const rel = relative(sourceRootAbs, filePath)
    const ns = rel.split(sep).slice(0, -1) // directory segments only
    await appendAgent({
      pluginName,
      pluginId,
      pluginRoot,
      filePath,
      namespaceSegments: ns,
      snapshot,
    })
  }
}

type AppendAgentInput = {
  pluginName: string
  pluginId: string
  pluginRoot: string
  filePath: string
  namespaceSegments: string[]
  snapshot: PluginSnapshot
}

async function appendAgent(input: AppendAgentInput): Promise<void> {
  const { pluginName, pluginId, pluginRoot, filePath, namespaceSegments, snapshot } = input

  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch (cause) {
    snapshot.errors.push({
      code: 'plugin_component_unreadable',
      message: `Failed to read plugin agent at ${filePath}.`,
      component: 'agents',
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
      component: 'agents',
      pluginId,
    } satisfies PluginLoadError)
    return
  }

  const frontmatter = parsed.frontmatter as Record<string, unknown>
  const fmName = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : ''
  if (!fmName) {
    snapshot.errors.push({
      code: 'plugin_agent_invalid',
      message: `Plugin agent ${filePath} is missing required "name" frontmatter.`,
      component: 'agents',
      pluginId,
      path: filePath,
    })
    return
  }

  // Detect silently-ignored fields. Recording them as warnings lets
  // operators diagnose a plugin that "doesn't work as advertised"
  // because it relied on a field the agent runtime strips.
  for (const key of IGNORED_AGENT_FRONTMATTER_KEYS) {
    if (frontmatter[key] !== undefined) {
      snapshot.errors.push({
        code: 'plugin_agent_field_ignored',
        message: `Plugin agent ${filePath} declared "${key}" — this field is ignored for plugin agents.`,
        component: 'agents',
        pluginId,
        path: filePath,
      })
    }
  }

  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''

  // Optional fields — accept the small set AgentDefinition supports.
  const model =
    typeof frontmatter.model === 'string' ? frontmatter.model.trim() : undefined
  const maxTurnsRaw = frontmatter.maxTurns
  let maxTurns: number | undefined
  if (typeof maxTurnsRaw === 'number' && Number.isFinite(maxTurnsRaw)) {
    maxTurns = maxTurnsRaw
  } else if (typeof maxTurnsRaw === 'string' && maxTurnsRaw.trim()) {
    const n = Number(maxTurnsRaw)
    if (Number.isFinite(n)) maxTurns = n
  }

  let forbiddenTools: string[] | undefined
  const rawForbidden = frontmatter.forbiddenTools
  if (Array.isArray(rawForbidden)) {
    forbiddenTools = rawForbidden.filter((s): s is string => typeof s === 'string')
  } else if (typeof rawForbidden === 'string') {
    forbiddenTools = rawForbidden
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }

  // Substitute `${CLAUDE_PLUGIN_ROOT}` in the body only. Use the
  // template literal substitution approach — do not invent a parser.
  const systemPrompt = substitutePluginRoot(parsed.body, pluginRoot)

  const exposedName = namespaceSegments.length
    ? `plugin:${pluginName}:${namespaceSegments.join(':')}:${fmName}`
    : `plugin:${pluginName}:${fmName}`

  const definition: AgentDefinition = {
    name: exposedName,
    description,
    systemPrompt,
    ...(model !== undefined && model.length > 0 ? { model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(forbiddenTools !== undefined && forbiddenTools.length > 0
      ? { forbiddenTools }
      : {}),
  }

  snapshot.agents.push(definition)

  // Suppress unused-binding warnings for `basename` / `dirname` imports.
  void basename
  void dirname
}

/**
 * Replace every occurrence of `${CLAUDE_PLUGIN_ROOT}` with `pluginRoot`.
 * Implemented as a literal string scan — no template engine involved.
 */
function substitutePluginRoot(body: string, pluginRoot: string): string {
  if (!pluginRoot) return body
  let result = ''
  let cursor = 0
  while (cursor < body.length) {
    const idx = body.indexOf(PLUGIN_ROOT_TOKEN, cursor)
    if (idx === -1) {
      result += body.slice(cursor)
      break
    }
    result += body.slice(cursor, idx) + pluginRoot
    cursor = idx + PLUGIN_ROOT_TOKEN.length
  }
  return result
}