import type { PluginRuntime } from './types.js'
import type {
  LoadedPlugin,
  PluginLoadError,
  PluginRuntimeConfig,
  PluginSnapshot,
} from './types.js'
import { emptyPluginSnapshot } from './types.js'
import { loadOpenccPluginCandidates } from './sources/opencc.js'
import { loadZaiPluginCandidates } from './sources/zai.js'
import { loadPluginSkills } from './components/skills.js'
import { loadPluginCommands } from './components/commands.js'
import { loadPluginAgents } from './components/agents.js'
import { loadPluginMcpServers } from './components/mcp.js'
import { loadPluginHooks } from './components/hooks.js'

/**
 * Augment `LoadedPlugin` with the optional `openccSourceRef` field that
 * records the original OpenCC marketplace key when the plugin survived
 * a merge. Used by diagnostics and the eventual project/managed loader.
 */
export type LoadedPluginWithMetadata = LoadedPlugin & {
  /**
   * Preserved when this plugin originated (or was shadowed by) an OpenCC
   * source entry. Lets downstream code log "demo@marketplace" even after
   * ZAI's local `demo` replaces it in the merge.
   */
  openccSourceRef?: string
}

/**
 * A `PluginSnapshot` whose `plugins` carry the optional `openccSourceRef`
 * metadata. The fields Task 4 fills (skills, agents, etc.) are still
 * arrays of their existing types.
 */
export type PluginSnapshotWithMetadata = Omit<PluginSnapshot, 'plugins'> & {
  plugins: LoadedPluginWithMetadata[]
}

export type PluginRegistryOptions = {
  opencc?: { configDir?: string; enabled?: boolean }
  zai?: {
    pluginsDir?: string
    settingsPath?: string
    enabled?: boolean
    enabledPlugins?: Record<string, boolean>
  }
}

/**
 * Discovery + merge layer for the OpenCC and ZAI plugin sources.
 *
 * `load({ cwd, signal })` runs OpenCC first, then ZAI, and merges by
 * canonical `manifest.name`. ZAI wins on collisions. The OpenCC
 * marketplace key (e.g. `demo@marketplace`) is preserved as
 * `openccSourceRef` on the surviving `LoadedPlugin` so diagnostics keep
 * the original identity.
 *
 * Caching: `load()` returns the same `PluginSnapshotWithMetadata`
 * reference until `clearCache()` is called. This lets callers call
 * `load()` repeatedly per session without re-reading the disk; callers
 * that want fresh reads can invalidate the cache explicitly.
 *
 * Discovery only — Task 4 fills `skills` / `agents` / `mcpServers` /
 * `hooks` / `pluginMcpServerNames` after the candidate merge.
 */
export class PluginRegistry implements PluginRuntime {
  private readonly config: PluginRegistryOptions
  private cache: PluginSnapshotWithMetadata | null = null
  private snapshotCache: Promise<PluginSnapshot> | null = null

  constructor(config: PluginRegistryOptions = {}) {
    this.config = config
  }

  async load(input: { cwd: string; signal?: AbortSignal }): Promise<PluginSnapshot> {
    if (input.signal?.aborted) {
      throw new Error('PluginRegistry.load: aborted')
    }
    if (this.cache) return this.cache

    const errors: PluginLoadError[] = []
    const merged = new Map<string, LoadedPluginWithMetadata>()

    if (this.config.opencc?.configDir && this.config.opencc.enabled !== false) {
      const openccResult = await loadOpenccPluginCandidates({
        configDir: this.config.opencc.configDir,
        cwd: input.cwd,
      })
      errors.push(...openccResult.errors)
      for (const candidate of openccResult.candidates) {
        const loaded: LoadedPluginWithMetadata = {
          ...candidate,
          enabled: true,
          openccSourceRef: candidate.sourceRef,
        }
        merged.set(candidate.id, loaded)
      }
    }

    if (this.config.zai?.pluginsDir && this.config.zai.enabled !== false) {
      const zaiResult = await loadZaiPluginCandidates({
        pluginsDir: this.config.zai.pluginsDir,
        settingsPath: this.config.zai.settingsPath,
        enabledPlugins: this.config.zai.enabledPlugins,
      })
      errors.push(...zaiResult.errors)
      for (const candidate of zaiResult.candidates) {
        const existing = merged.get(candidate.id)
        const loaded: LoadedPluginWithMetadata = {
          ...candidate,
          enabled: true,
          ...(existing?.openccSourceRef !== undefined
            ? { openccSourceRef: existing.openccSourceRef }
            : {}),
        }
        merged.set(candidate.id, loaded)
      }
    }

    const snapshot: PluginSnapshotWithMetadata = {
      ...emptyPluginSnapshot(),
      plugins: Array.from(merged.values()),
      errors,
    }
    this.cache = snapshot
    return snapshot
  }

  loadSnapshot(input: { cwd: string; signal?: AbortSignal }): Promise<PluginSnapshot> {
    this.snapshotCache ??= this.load(input).then(async snapshot => {
      await Promise.all(snapshot.plugins.flatMap(plugin => [
        loadPluginSkills(plugin, snapshot),
        loadPluginCommands(plugin, snapshot),
        loadPluginAgents(plugin, snapshot),
        loadPluginMcpServers(plugin, snapshot),
        loadPluginHooks(plugin, snapshot),
      ]))
      return snapshot
    })
    return this.snapshotCache
  }

  clearCache(): void {
    this.cache = null
    this.snapshotCache = null
  }
}

/**
 * Convert a public `PluginRuntimeConfig` (from `runtime/types.ts`) into
 * the registry's internal shape. Exposed so callers like Task 6 can
 * build a registry without re-deriving field names.
 */
export function registryOptionsFromConfig(
  config: PluginRuntimeConfig | undefined,
): PluginRegistryOptions {
  if (!config) return {}
  return {
    opencc: config.opencc
      ? {
          ...(config.opencc.configDir !== undefined
            ? { configDir: config.opencc.configDir }
            : {}),
          ...(config.opencc.enabled !== undefined ? { enabled: config.opencc.enabled } : {}),
        }
      : undefined,
    zai: config.zai
      ? {
          ...(config.zai.pluginsDir !== undefined
            ? { pluginsDir: config.zai.pluginsDir }
            : {}),
          ...(config.zai.settingsPath !== undefined
            ? { settingsPath: config.zai.settingsPath }
            : {}),
          ...(config.zai.enabled !== undefined ? { enabled: config.zai.enabled } : {}),
          ...(config.zai.enabledPlugins !== undefined
            ? { enabledPlugins: config.zai.enabledPlugins }
            : {}),
        }
      : undefined,
  }
}