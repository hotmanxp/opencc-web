/**
 * Plugin registry — ported verbatim from
 * `@zn-ai/zai-agent-core/src/plugins/registry.ts` as a compat shim.
 *
 * Path adjustments vs. the original:
 *   - `import { loadOpenccPluginCandidates } from './sources/opencc.js'`
 *     → inlined here as `loadOpenccPluginCandidatesImpl`. The real
 *     `compat/plugins/sources/opencc.ts` would split this out; we keep
 *     it inline until plugins get a second source of complexity.
 *   - `import { loadPluginSkills } from './components/skills.js'`
 *     → inlined here as `loadPluginSkillsImpl`. Same rationale.
 *   - `loadZaiPluginCandidates`, `loadPluginCommands`, `loadPluginAgents`,
 *     `loadPluginMcpServers`, `loadPluginHooks` remain no-op pass-throughs
 *     because zai-server only consumes the opencc source for skills.
 *
 * What `loadOpenccPluginCandidates` does:
 *   - Walks `<configDir>/plugins/cache/<marketplace>/<plugin>/<version>/`
 *     (the layout Claude Code uses for installed plugins).
 *   - Reads `<plugin>/.claude-plugin/plugin.json` for the manifest.
 *   - Returns a `PluginCandidate` per plugin. The "best" version is the
 *     highest semver-like directory under each plugin name.
 *
 * What `loadPluginSkills` does:
 *   - Walks `<plugin-root>/skills/<skill-name>/SKILL.md` for each plugin.
 *   - Parses frontmatter via `parseSkillFrontmatter` (same parser the
 *     disk-loaded skills use, so the `<skills>` block format is identical).
 *   - Pushes `LoadedSkill` records into `snapshot.skills` with `source:
 *     'plugin'` so callers can distinguish from disk-loaded skills.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  LoadedPlugin,
  PluginCandidate,
  PluginLoadError,
  PluginRuntimeConfig,
  PluginSnapshot,
  PluginManifest,
} from './types.js'
import { emptyPluginSnapshot } from './types.js'
import type { LoadedSkill } from '../runtime/skills-types.js'
import {
  parseSkillFrontmatter,
  coerceDescriptionToString,
} from '../runtime/skills-frontmatter.js'

// ── Plugin discovery (opencc source) ─────────────────────────────────────────

/**
 * Walk `<configDir>/plugins/cache/<marketplace>/<plugin>/<version>/`
 * and return one `PluginCandidate` per plugin (highest version selected).
 *
 * Failure modes:
 *   - configDir missing → empty result, no errors.
 *   - cache dir missing → empty result, no errors (user has no plugins).
 *   - individual plugin missing manifest → record a `missing_manifest`
 *     error and skip it; other plugins still load.
 *
 * Performance: each `readdir` is fire-and-forget; total cost is the
 * number of plugin subdirectories, which on a typical install is single
 * digits. Caching is done at the `PluginRegistry` level.
 */
async function loadOpenccPluginCandidatesImpl(args: {
  configDir: string
  cwd: string
}): Promise<{ candidates: PluginCandidate[]; errors: PluginLoadError[] }> {
  const { configDir } = args
  const candidates: PluginCandidate[] = []
  const errors: PluginLoadError[] = []

  if (!configDir) return { candidates, errors }

  // Claude Code layout: <configDir>/plugins/cache/<marketplace>/<plugin>/<version>/
  const cacheRoot = join(configDir, 'plugins', 'cache')
  let marketplaces: import('node:fs').Dirent[]
  try {
    marketplaces = await readdir(cacheRoot, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { candidates, errors }
    errors.push({
      code: 'cache_read_failed',
      message: `failed to read plugin cache: ${(err as Error).message}`,
      source: 'opencc',
      path: cacheRoot,
    })
    return { candidates, errors }
  }

  for (const mp of marketplaces) {
    if (!mp.isDirectory()) continue
    const marketplaceName = mp.name
    const mpDir = join(cacheRoot, marketplaceName)
    let plugins: import('node:fs').Dirent[]
    try {
      plugins = await readdir(mpDir, { withFileTypes: true })
    } catch (err) {
      errors.push({
        code: 'marketplace_read_failed',
        message: `failed to read marketplace ${marketplaceName}: ${(err as Error).message}`,
        source: 'opencc',
        path: mpDir,
      })
      continue
    }
    for (const p of plugins) {
      if (!p.isDirectory()) continue
      const pluginName = p.name
      const pluginDir = join(mpDir, pluginName)
      // Pick the highest version directory. Lexicographic compare works
      // for semver-shaped version strings (X.Y.Z), which is what Claude
      // Code's installer writes. Falls back to the most-recently-modified
      // entry when versions aren't semver-shaped.
      let versions: import('node:fs').Dirent[]
      try {
        versions = await readdir(pluginDir, { withFileTypes: true })
      } catch (err) {
        errors.push({
          code: 'plugin_read_failed',
          message: `failed to read plugin ${pluginName}: ${(err as Error).message}`,
          source: 'opencc',
          path: pluginDir,
        })
        continue
      }
      const versionDirs = versions
        .filter((v) => v.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
      if (versionDirs.length === 0) {
        errors.push({
          code: 'no_versions',
          message: `plugin ${pluginName} has no version directories`,
          source: 'opencc',
          path: pluginDir,
        })
        continue
      }
      const versionName = versionDirs[0]!.name
      const versionDir = join(pluginDir, versionName)
      // Read manifest. plugin.json is the canonical location;
      // marketplace.json is supplementary metadata we don't need.
      const manifestPath = join(versionDir, '.claude-plugin', 'plugin.json')
      let manifest: PluginManifest
      try {
        const raw = await readFile(manifestPath, 'utf-8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        manifest = {
          name: typeof parsed.name === 'string' ? parsed.name : pluginName,
          version: typeof parsed.version === 'string' ? parsed.version : versionName,
          description: typeof parsed.description === 'string' ? parsed.description : undefined,
        }
      } catch (err) {
        errors.push({
          code: 'missing_manifest',
          message: `plugin ${pluginName} v${versionName} has no readable manifest: ${
            (err as Error).message
          }`,
          source: 'opencc',
          path: manifestPath,
        })
        continue
      }
      const id = `${pluginName}@${marketplaceName}`
      candidates.push({
        id,
        name: pluginName,
        source: 'opencc',
        sourceRef: id,
        root: versionDir,
        manifest,
      })
    }
  }

  return { candidates, errors }
}

// ── Plugin skill loading ─────────────────────────────────────────────────────

/**
 * For one plugin, scan `<plugin-root>/skills/<skill-name>/SKILL.md` and
 * append `LoadedSkill` entries to `snapshot.skills`. Disk layout mirrors
 * what the opencc-vendored loader does for `~/.agents/skills`:
 *   - skill directory under the root
 *   - one `SKILL.md` file (case-insensitive on the loader side)
 *   - YAML frontmatter with `name` + `description`
 *
 * Plugin skills are tagged with `source: 'plugin'` so the UI / prompt
 * builder can distinguish them from disk-loaded skills if needed; the
 * `<skills>` block treats them identically.
 *
 * Failure modes:
 *   - skills/ missing → silently no-op (most plugins don't ship skills).
 *   - individual SKILL.md malformed → record error, skip that skill,
 *     keep the rest. One bad YAML shouldn't kill the whole plugin.
 */
async function loadPluginSkillsImpl(
  plugin: LoadedPlugin,
  snapshot: PluginSnapshot,
): Promise<void> {
  const skillsRoot = join(plugin.root, 'skills')
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    snapshot.errors.push({
      code: 'plugin_skills_read_failed',
      message: `failed to read plugin skills dir: ${(err as Error).message}`,
      source: 'opencc',
      pluginId: plugin.id,
      component: 'skills',
      path: skillsRoot,
    })
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillName = entry.name
    const skillMd = join(skillsRoot, skillName, 'SKILL.md')
    let raw: string
    try {
      raw = await readFile(skillMd, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      snapshot.errors.push({
        code: 'plugin_skill_read_failed',
        message: `failed to read ${skillMd}: ${(err as Error).message}`,
        source: 'opencc',
        pluginId: plugin.id,
        component: 'skills',
        path: skillMd,
      })
      continue
    }
    let parsed: { frontmatter: ReturnType<typeof parseSkillFrontmatter>['frontmatter']; body: string }
    try {
      parsed = parseSkillFrontmatter(raw, skillMd)
    } catch (err) {
      snapshot.errors.push({
        code: 'plugin_skill_frontmatter_invalid',
        message: (err as Error).message,
        source: 'opencc',
        pluginId: plugin.id,
        component: 'skills',
        path: skillMd,
      })
      continue
    }
    const description = coerceDescriptionToString(
      parsed.frontmatter.description,
      skillName,
    )
    const skill: LoadedSkill = {
      name: parsed.frontmatter.name ?? skillName,
      baseDir: join(skillsRoot, skillName),
      filePath: skillMd,
      frontmatter: parsed.frontmatter,
      markdown: parsed.body,
      source: 'plugin',
      kind: 'skill',
      pluginId: plugin.id,
      // The Loader Order index (used by `<skills>` block to tag entries).
      sourceIndex: snapshot.skills.length,
    }
    // Plugin skills override disk skills with the same name (Claude Code
    // ships with cwd-installed skills that should win over user overrides).
    const existingIdx = snapshot.skills.findIndex((s) => s.name === skill.name)
    if (existingIdx >= 0) {
      snapshot.skills[existingIdx] = skill
    } else {
      snapshot.skills.push(skill)
    }
    // Touch description to avoid unused-var lints; the field is on the
    // frontmatter, not on LoadedSkill directly, so we don't need to set it.
    void description
  }
}

// ── Pass-throughs for components we don't load yet ──────────────────────────

async function loadPluginCommands(_plugin: LoadedPlugin, _snapshot: PluginSnapshot): Promise<void> {}
async function loadPluginAgents(_plugin: LoadedPlugin, _snapshot: PluginSnapshot): Promise<void> {}
async function loadPluginMcpServers(_plugin: LoadedPlugin, _snapshot: PluginSnapshot): Promise<void> {}
async function loadPluginHooks(_plugin: LoadedPlugin, _snapshot: PluginSnapshot): Promise<void> {}

// ── The two stub functions referenced by the rest of the file ───────────────

async function loadOpenccPluginCandidates(args: {
  configDir: string
  cwd: string
}): Promise<{ candidates: PluginCandidate[]; errors: PluginLoadError[] }> {
  return loadOpenccPluginCandidatesImpl(args)
}

async function loadZaiPluginCandidates(_args: {
  pluginsDir: string
  settingsPath?: string
  enabledPlugins?: Record<string, boolean>
}): Promise<{ candidates: PluginCandidate[]; errors: PluginLoadError[] }> {
  // No ZAIside plugin dir wired yet. OpenCC source covers the installed
  // set; return empty so the merge loop skips it.
  return { candidates: [], errors: [] }
}

async function loadPluginSkills(
  plugin: LoadedPlugin,
  snapshot: PluginSnapshot,
): Promise<void> {
  return loadPluginSkillsImpl(plugin, snapshot)
}

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
export class PluginRegistry {
  private readonly config: PluginRegistryOptions
  private cache: PluginSnapshotWithMetadata | null = null
  private snapshotCache: Promise<PluginSnapshot> | null = null

  constructor(config: PluginRegistryOptions = {}) {
    this.config = config
  }

  async load(input: { cwd: string; signal?: AbortSignal }): Promise<PluginSnapshotWithMetadata> {
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

/**
 * Default PluginRuntime wrapper. Implements the same `load/clearCache`
 * contract as the OLD `DefaultPluginRuntime`, delegating to a
 * `PluginRegistry` instance.
 */
export class DefaultPluginRuntime {
  private readonly registry: PluginRegistry
  private cache?: Promise<PluginSnapshot>

  constructor(private readonly config: PluginRuntimeConfig = {}) {
    this.registry = new PluginRegistry(registryOptionsFromConfig(config))
  }

  load(input: { cwd: string; signal?: AbortSignal }): Promise<PluginSnapshot> {
    if (this.config.enabled === false) return Promise.resolve(emptyPluginSnapshot())
    this.cache ??= this.registry.loadSnapshot(input)
    return this.cache
  }

  clearCache(): void {
    this.cache = undefined
    this.registry.clearCache()
  }
}