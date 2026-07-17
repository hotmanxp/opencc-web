import { stat } from 'fs/promises'
import { join } from 'path'
import { resolvePluginPath, readJsonFileIfPresent } from '../manifest.js'
import { serializeError } from '../errors.js'
import type {
  LoadedPlugin,
  PluginHook,
  PluginSnapshot,
} from '../types.js'

const HOOKS_FILENAME = 'hooks.json'
const HOOKS_STANDARD_DIR = 'hooks'

/**
 * Whitelist of hook events supported in phase 1. Anything outside this
 * set is rejected with `unsupported-hook-event`. Hard-coded here rather
 * than in the global constraints doc so the loader can enforce the
 * boundary without re-parsing the plan file.
 */
const SUPPORTED_HOOK_EVENTS = new Set<string>([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
])

/**
 * Shape of one entry in a hooks config file. OpenCC writes:
 *
 * ```json
 * {
 *   "PreToolUse": [
 *     { "matcher": "Bash", "hooks": [{ "type": "command", "command": "..." }] }
 *   ]
 * }
 * ```
 *
 * `matcher` is optional. Each matcher contains one or more hook
 * definitions (we only support `type: 'command'` in phase 1).
 */
type RawHooksFile = {
  hooks?: Record<string, RawHookMatcher[]>
}

type RawHookMatcher = {
  matcher?: string
  hooks?: RawHookDefinition[]
}

type RawHookDefinition = {
  type?: string
  command?: unknown
  timeoutMs?: unknown
}

/**
 * Load plugin hooks from `<root>/hooks/hooks.json` and from
 * `manifest.hooks` (inline `HooksSchema`-shaped object). Merge both
 * sources. Filter to the supported event whitelist; emit
 * `unsupported-hook-event` errors for any other event. Each valid hook
 * is appended to `snapshot.hooks` with the `pluginId` and `pluginRoot`
 * fields attached for downstream `HookRunner` use.
 *
 * Failures (parse errors, IO errors, individual hook shape errors) are
 * pushed to `snapshot.errors` and never abort the loop.
 */
export async function loadPluginHooks(
  plugin: LoadedPlugin,
  snapshot: PluginSnapshot,
): Promise<void> {
  const pluginId = plugin.id
  const pluginRoot = plugin.root

  // 1. Standard hooks/hooks.json file.
  const standardPath = join(plugin.root, HOOKS_STANDARD_DIR, HOOKS_FILENAME)
  const standardStat = await stat(standardPath).catch(() => null)
  if (standardStat && standardStat.isFile()) {
    await ingestHooksFile({
      filePath: standardPath,
      pluginId,
      pluginRoot,
      snapshot,
    })
  }

  // 2. manifest.hooks — either an inline object or a relative JSON path.
  const declared = plugin.manifest.hooks
  if (declared === undefined || declared === null) return

  if (typeof declared === 'string') {
    await ingestRelativePath({
      relPath: declared,
      pluginId,
      pluginRoot,
      snapshot,
    })
    return
  }

  if (typeof declared === 'object' && !Array.isArray(declared)) {
    await ingestHooksObject({
      raw: declared,
      origin: 'manifest.hooks',
      pluginId,
      pluginRoot,
      snapshot,
    })
    return
  }

  snapshot.errors.push({
    code: 'plugin_hooks_invalid',
    message: `Plugin manifest.hooks must be an object or a relative path string.`,
    component: 'hooks',
    pluginId,
  })
}

async function ingestRelativePath(input: {
  relPath: string
  pluginId: string
  pluginRoot: string
  snapshot: PluginSnapshot
}): Promise<void> {
  const { relPath, pluginId, pluginRoot, snapshot } = input

  let resolved: string
  try {
    resolved = await resolvePluginPath(pluginRoot, relPath, 'hooks')
  } catch (cause) {
    snapshot.errors.push({
      code: 'plugin_path_outside_root',
      message: `Plugin hooks path "${relPath}" resolves outside the plugin root.`,
      component: 'hooks',
      pluginId,
      path: relPath,
      detail: serializeError(cause),
    })
    return
  }

  const st = await stat(resolved).catch(() => null)
  if (!st || !st.isFile()) {
    snapshot.errors.push({
      code: 'plugin_component_missing',
      message: `Plugin hooks path "${relPath}" does not exist or is not a file.`,
      component: 'hooks',
      pluginId,
      path: relPath,
    })
    return
  }

  await ingestHooksFile({
    filePath: resolved,
    pluginId,
    pluginRoot,
    snapshot,
  })
}

async function ingestHooksFile(input: {
  filePath: string
  pluginId: string
  pluginRoot: string
  snapshot: PluginSnapshot
}): Promise<void> {
  const { filePath, pluginId, pluginRoot, snapshot } = input

  let raw: unknown
  try {
    raw = await readJsonFileIfPresent(filePath)
  } catch (cause) {
    snapshot.errors.push({
      code: 'plugin_hooks_parse_error',
      message: `Failed to parse plugin hooks file ${filePath}.`,
      component: 'hooks',
      pluginId,
      path: filePath,
      detail: serializeError(cause),
    })
    return
  }
  if (raw === null) {
    snapshot.errors.push({
      code: 'plugin_component_missing',
      message: `Plugin hooks file ${filePath} could not be read.`,
      component: 'hooks',
      pluginId,
      path: filePath,
    })
    return
  }

  await ingestHooksObject({
    raw,
    origin: filePath,
    pluginId,
    pluginRoot,
    snapshot,
  })
}

async function ingestHooksObject(input: {
  raw: unknown
  origin: string
  pluginId: string
  pluginRoot: string
  snapshot: PluginSnapshot
}): Promise<void> {
  const { raw, origin, pluginId, pluginRoot, snapshot } = input

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    snapshot.errors.push({
      code: 'plugin_hooks_invalid',
      message: `Plugin hooks payload from ${origin} must be an object.`,
      component: 'hooks',
      pluginId,
      path: origin,
    })
    return
  }

  // Accept either `{ hooks: { Event: [...] } }` (canonical OpenCC shape)
  // or a bare `{ Event: [...] }` mapping.
  const obj = raw as Record<string, unknown>
  const inner =
    obj.hooks && typeof obj.hooks === 'object' && !Array.isArray(obj.hooks)
      ? (obj.hooks as Record<string, unknown>)
      : obj

  for (const [event, matchersRaw] of Object.entries(inner)) {
    if (!SUPPORTED_HOOK_EVENTS.has(event)) {
      // Unsupported event → record and skip ALL matchers under it.
      snapshot.errors.push({
        code: 'unsupported-hook-event',
        message: `Plugin hook event "${event}" is not supported.`,
        component: 'hooks',
        pluginId,
        path: origin,
        detail: { event },
      })
      continue
    }

    if (!Array.isArray(matchersRaw)) {
      snapshot.errors.push({
        code: 'plugin_hooks_invalid',
        message: `Plugin hooks payload for event "${event}" must be an array.`,
        component: 'hooks',
        pluginId,
        path: origin,
      })
      continue
    }

    for (const matcherRaw of matchersRaw) {
      appendMatcher({
        event,
        matcherRaw,
        origin,
        pluginId,
        pluginRoot,
        snapshot,
      })
    }
  }
}

function appendMatcher(input: {
  event: string
  matcherRaw: unknown
  origin: string
  pluginId: string
  pluginRoot: string
  snapshot: PluginSnapshot
}): void {
  const { event, matcherRaw, origin, pluginId, pluginRoot, snapshot } = input

  if (!matcherRaw || typeof matcherRaw !== 'object' || Array.isArray(matcherRaw)) {
    snapshot.errors.push({
      code: 'plugin_hooks_invalid',
      message: `Hook matcher for event "${event}" must be an object.`,
      component: 'hooks',
      pluginId,
      path: origin,
    })
    return
  }

  const matcher = matcherRaw as RawHookMatcher
  const matcherStr =
    typeof matcher.matcher === 'string' && matcher.matcher.length > 0
      ? matcher.matcher
      : undefined

  if (!Array.isArray(matcher.hooks)) {
    snapshot.errors.push({
      code: 'plugin_hooks_invalid',
      message: `Hook matcher for event "${event}" must contain a "hooks" array.`,
      component: 'hooks',
      pluginId,
      path: origin,
    })
    return
  }

  for (const defRaw of matcher.hooks) {
    const def = defRaw as RawHookDefinition
    const type = typeof def.type === 'string' ? def.type : 'command'
    if (type !== 'command') {
      snapshot.errors.push({
        code: 'unsupported-hook-type',
        message: `Hook type "${type}" for event "${event}" is not supported.`,
        component: 'hooks',
        pluginId,
        path: origin,
      })
      continue
    }
    if (typeof def.command !== 'string' || def.command.length === 0) {
      snapshot.errors.push({
        code: 'plugin_hooks_invalid',
        message: `Hook definition for event "${event}" must have a non-empty "command".`,
        component: 'hooks',
        pluginId,
        path: origin,
      })
      continue
    }
    const timeoutMs =
      typeof def.timeoutMs === 'number' && Number.isFinite(def.timeoutMs) && def.timeoutMs > 0
        ? def.timeoutMs
        : undefined

    const hook: PluginHook = {
      event,
      ...(matcherStr ? { matcher: matcherStr } : {}),
      command: def.command,
      pluginId,
      pluginRoot,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }
    snapshot.hooks.push(hook)
  }
}