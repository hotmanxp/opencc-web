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
// InstalledPluginsFileV2 is defined in schemas.ts and only *imported*
// (not re-exported) by installedPluginsManager.ts, so pull it from the
// defining module directly.
import type { InstalledPluginsFileV2 } from '../utils/plugins/schemas.js'
import type {
  OpenccPluginDto,
  OpenccPluginListResult,
  OpenccPluginScope,
  OpenccPluginComponentCounts,
} from './serverTypes.js'
import { getPluginErrorMessage } from '../types/plugin.js'
import {
  buildPluginId,
  parsePluginIdentifier,
} from '../utils/plugins/pluginIdentifier.js'

/**
 * `plugin.repository` 在 `pluginLoader.ts:1464` 被赋值为 `source`,而 `source`
 * 在上游多处会被填成完整 pluginId 形如 `pluginName@marketplace`(而非纯
 * marketplace 名),导致直接拼接 `${name}@${repository}` 产出
 * `name@name@marketplace` 这种重复 id。这里统一抽 marketplace:
 *   - 不含 `@` → 视为纯 marketplace 名(如单元测试与部分 builtin 场景)
 *   - 含 `@` → 取第一个 `@` 之后的部分(marketplace 名,parsePluginIdentifier 语义)
 *
 * 这样不管 repository 是裸名还是被 source 污染的完整 id,id 永远形如
 * `name@marketplace`,parsePluginIdentifier(id).marketplace 也能拿到正确值。
 */
function resolveMarketplace(repository: string): string | undefined {
  return repository.includes('@')
    ? parsePluginIdentifier(repository).marketplace
    : repository
}

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
  const entries = installedV2.plugins[pluginName] ?? []
  const scopes = entries.map((e) => e.scope)
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
  // Non built-in: `plugin.repository` may be either a bare marketplace name
  // (e.g. 'market') or a full pluginId ('pluginName@marketplace') depending
  // on how the loader filled `source`. resolveMarketplace() handles both —
  // see its doc above. Built-in keeps the full repository value as before
  // (e.g. 'b@builtin') for backwards compatibility with PluginRow's Tag.
  const marketplace = isBuiltin
    ? plugin.repository
    : (resolveMarketplace(plugin.repository) ?? plugin.repository)
  const id = isBuiltin ? plugin.repository : buildPluginId(plugin.name, marketplace)
  // zai patch (2026-10-10, mods 同步):mod 投影也带 isBuiltin —— 目的是让
  // 它绕开 install/uninstall/update 流水线(两个来源都不是市场装的)。但
  // 磁盘 mod 在用户眼里就是「用户自己放的」,标成「内置」会误导,所以作用域
  // 按 mod 的真实来源给;内置 mod 才显示「内置」。
  const scope: OpenccPluginScope = plugin.mod
    ? (plugin.mod.builtin ? 'builtin' : 'user')
    : isBuiltin
      ? 'builtin'
      : deriveScope(plugin.name, installedV2)
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
    marketplace,
    scope,
    enabled,
    writable: scopeToWritable(scope, isBuiltin),
    hasUpdate: hasUpdateFor(id),
    components: componentCounts.get(plugin.name) ?? {
      commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0,
    },
    errors: errorsForPlugin(plugin.name, errors),
    // zai patch (2026-10-10, mods 同步):透传 mod 元信息,让 UI 能标出这是
    // 一个 mod 并展示它注册了什么。真插件此处为 undefined。
    ...(plugin.mod ? { mod: plugin.mod } : {}),
  }
}

export function assemblePluginList(
  loadResult: PluginLoadResult,
  installedV2: InstalledPluginsFileV2,
  enabledSettings: Record<string, boolean> | undefined,
  componentCounts: Map<string, OpenccPluginComponentCounts>,
  hasUpdateFor: (id: string) => boolean = () => false,
  /**
   * zai patch (2026-10-10, mods 同步):mod 的插件投影(`getModsAsPlugins()`),
   * 与真插件并入同一张列表。默认空数组 —— 调用方不传时本函数行为与
   * 引入 mod 之前完全一致,便于既有单测不受影响。
   */
  modPlugins: readonly LoadedPlugin[] = [],
): OpenccPluginListResult {
  const all = [...loadResult.enabled, ...loadResult.disabled]
  const plugins = [...all, ...modPlugins].map((p) =>
    toDto(p, installedV2, enabledSettings, componentCounts, loadResult.errors, hasUpdateFor),
  )
  return { plugins, errors: topLevelErrors(loadResult.errors) }
}
