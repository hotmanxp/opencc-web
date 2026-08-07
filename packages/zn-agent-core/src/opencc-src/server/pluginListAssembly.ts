/**
 * Pure assembly of installed-plugin DTOs.
 *
 * Pulled out of `createOpenccRuntime-impl.ts` so the merge logic
 * (`loadAllPlugins()` result + installed_plugins v2 + `enabledPlugins`
 * settings + per-plugin component counts → `OpenccPluginDto[]`) can be
 * unit-tested without touching the filesystem. Pure function, no I/O.
 *
 * Lives next to `serverTypes.ts` (same emit) so the `.d.ts` stays
 * self-contained per `verify-server-types-self-contained.mjs`.
 */
import type { PluginError, PluginLoadResult, LoadedPlugin } from '../types/plugin.js'
import type { InstalledPluginsFileV2 } from '../utils/plugins/installedPluginsManager.js'
import type {
  OpenccPluginDto,
  OpenccPluginListResult,
  OpenccPluginScope,
  OpenccPluginComponentCounts,
} from './serverTypes.js'
import { getPluginErrorMessage } from '../types/plugin.js'

const WRITABLE_SCOPES: ReadonlySet<OpenccPluginScope> = new Set(['user', 'builtin'])

function isBuiltinPluginId(id: string): boolean {
  return id.endsWith('@builtin')
}

function scopeToWritable(scope: OpenccPluginScope, isBuiltin: boolean): boolean {
  if (isBuiltin) return true
  return WRITABLE_SCOPES.has(scope)
}

function deriveScope(
  pluginName: string,
  installedV2: InstalledPluginsFileV2,
): OpenccPluginScope {
  if (isBuiltinPluginId(pluginName)) return 'builtin'
  const v2 = installedV2.plugins[pluginName]
  if (!v2) return 'user'
  const scopes = Object.keys(v2.installs ?? {})
  if (scopes.includes('user')) return 'user'
  if (scopes.includes('project')) return 'project'
  if (scopes.includes('local')) return 'local'
  return 'user'
}

function errorsForPlugin(
  pluginName: string,
  errors: PluginError[],
): string[] {
  return errors
    .filter((e) => 'plugin' in e && e.plugin === pluginName)
    .map(getPluginErrorMessage)
}

function topLevelErrors(errors: PluginError[]): string[] {
  return errors
    .filter((e) => !('plugin' in e && e.plugin))
    .map(getPluginErrorMessage)
}

function toDto(
  plugin: LoadedPlugin,
  installedV2: InstalledPluginsFileV2,
  enabledSettings: Record<string, boolean> | undefined,
  componentCounts: Map<string, OpenccPluginComponentCounts>,
  errors: PluginError[],
  hasUpdateFor: (id: string) => boolean,
): OpenccPluginDto {
  const isBuiltin = plugin.isBuiltin === true
  // Built-in plugin ids use the full repository value (e.g. 'b@builtin') set by getBuiltinPlugins().
  const id = isBuiltin ? plugin.repository : `${plugin.name}@${plugin.repository}`
  const scope = isBuiltin ? 'builtin' : deriveScope(plugin.name, installedV2)
  // enabled: built-in always reads enabledPlugins; otherwise read from settings.
  const enabled = isBuiltin
    ? (enabledSettings?.[id] ?? true)
    : (enabledSettings?.[id] ?? plugin.enabled === true)
  return {
    id,
    name: plugin.name,
    description: plugin.manifest.description,
    version: plugin.manifest.version,
    author: plugin.manifest.author
      ? typeof plugin.manifest.author === 'string'
        ? plugin.manifest.author
        : plugin.manifest.author.name
      : undefined,
    marketplace: plugin.repository,
    scope,
    enabled,
    writable: scopeToWritable(scope, isBuiltin),
    hasUpdate: hasUpdateFor(id),
    components: componentCounts.get(plugin.name) ?? {
      commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0,
    },
    errors: errorsForPlugin(plugin.name, errors),
  }
}

export function assemblePluginList(
  loadResult: PluginLoadResult,
  installedV2: InstalledPluginsFileV2,
  enabledSettings: Record<string, boolean> | undefined,
  componentCounts: Map<string, OpenccPluginComponentCounts>,
  hasUpdateFor: (id: string) => boolean = () => false,
): OpenccPluginListResult {
  const all = [...loadResult.enabled, ...loadResult.disabled]
  const plugins = all.map((p) =>
    toDto(p, installedV2, enabledSettings, componentCounts, loadResult.errors, hasUpdateFor),
  )
  return { plugins, errors: topLevelErrors(loadResult.errors) }
}
