import { readFile, realpath, stat } from 'fs/promises'
import { join } from 'path'
import { readPluginManifest } from '../manifest.js'
import { resolveOpenccPluginsDir } from '../paths.js'
import type {
  PluginCandidate,
  PluginCandidateResult,
  PluginLoadError,
  PluginManifest,
} from '../types.js'

/**
 * Shape of one row in `installed_plugins.json` (V2 format).
 *
 * `scope` is one of `'user' | 'managed' | 'project' | 'local'`. The first
 * two are always available; the latter two are kept only when their
 * `projectPath` matches the caller-supplied `cwd`.
 */
export type PluginInstallationEntry = {
  scope: 'user' | 'managed' | 'project' | 'local' | string
  installPath: string
  projectPath?: string
  [key: string]: unknown
}

export type InstalledPluginsFile = {
  version: number
  plugins: Record<string, PluginInstallationEntry[]>
}

export type LoadOpenccInput = {
  configDir: string
  cwd: string
}

const ENABLED_PLUGINS_KEY = 'enabledPlugins' as const

/**
 * Read OpenCC plugin candidates from
 * `<configDir>/plugins/installed_plugins.json`, applying scope and
 * `enabledPlugins` filters.
 *
 * Discovery rules:
 *   - `installed_plugins.json` missing → empty result, no errors.
 *   - JSON parse failure → structured `installed_plugins_invalid` error,
 *     empty candidates.
 *   - For each `pluginId` × installation entry:
 *     - skip entries whose `installPath` is not an existing directory
 *     - skip `project`/`local` entries whose `projectPath !== cwd`
 *     - try `readPluginManifest`; on failure, push the structured error
 *       and skip just that entry
 *   - Apply `enabledPlugins` filter from settings files in priority order
 *     (later in list wins). Lookup accepts BOTH the OpenCC plugin id
 *     (e.g. `demo@marketplace`) AND the canonical manifest name.
 *
 * Canonical merge key is `manifest.name`. `sourceRef` preserves the
 * original OpenCC id so the registry can keep that metadata when the
 * plugin survives the merge.
 */
export async function loadOpenccPluginCandidates(
  input: LoadOpenccInput,
): Promise<PluginCandidateResult> {
  const { configDir, cwd } = input
  const pluginsDir = resolveOpenccPluginsDir(configDir)
  const errors: PluginLoadError[] = []
  const candidates: PluginCandidate[] = []

  const installedFile = join(pluginsDir, 'installed_plugins.json')
  const raw = await readFileOrNull(installedFile)
  if (raw === null) {
    return { candidates: [], errors: [] }
  }

  let parsed: InstalledPluginsFile
  try {
    parsed = JSON.parse(raw) as InstalledPluginsFile
  } catch (cause) {
    errors.push({
      code: 'installed_plugins_invalid',
      message: `Failed to parse JSON at ${installedFile}.`,
      source: 'opencc',
      path: installedFile,
      detail: serializeCaught(cause),
    })
    return { candidates: [], errors }
  }

  const enabledPlugins = await readEnabledPlugins(input)
  const pluginsRecord = parsed.plugins ?? {}

  for (const [pluginId, entries] of Object.entries(pluginsRecord)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const candidate = await buildCandidate(pluginId, entry, cwd, errors)
      if (candidate && isEnabled(pluginId, candidate, enabledPlugins)) {
        candidates.push(candidate)
      }
    }
  }

  return { candidates, errors }
}

async function buildCandidate(
  pluginId: string,
  entry: PluginInstallationEntry,
  cwd: string,
  errors: PluginLoadError[],
): Promise<PluginCandidate | null> {
  if (!entry || typeof entry.installPath !== 'string') {
    return null
  }
  if (entry.scope === 'project' || entry.scope === 'local') {
    if (typeof entry.projectPath !== 'string' || entry.projectPath !== cwd) {
      return null
    }
  }

  if (!(await directoryExists(entry.installPath))) {
    return null
  }

  let realInstallPath: string
  try {
    realInstallPath = await realpath(entry.installPath)
  } catch {
    return null
  }

  const manifestResult = await readPluginManifest(realInstallPath)
  if (manifestResult.error || !manifestResult.manifest) {
    if (manifestResult.error) errors.push(manifestResult.error)
    return null
  }

  return candidateFromManifest(pluginId, realInstallPath, manifestResult.manifest)
}

function candidateFromManifest(
  pluginId: string,
  root: string,
  manifest: PluginManifest,
): PluginCandidate {
  return {
    id: manifest.name,
    name: manifest.name,
    source: 'opencc',
    sourceRef: pluginId,
    root,
    manifest,
  }
}

/**
 * Settings files in priority order. Later entries override earlier ones.
 * Mirrors OpenCC's own load order: config dir first, then project, with
 * `.local` files layered on top of their non-local counterpart.
 */
function settingsFilePaths(input: LoadOpenccInput): string[] {
  const { configDir, cwd } = input
  return [
    join(configDir, '.claude', 'settings.json'),
    join(configDir, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ]
}

async function readEnabledPlugins(
  input: LoadOpenccInput,
): Promise<Record<string, boolean>> {
  let merged: Record<string, boolean> = {}
  for (const path of settingsFilePaths(input)) {
    const map = extractEnabledPlugins(await readJsonIfPresent(path))
    if (map) merged = { ...merged, ...map }
  }
  return merged
}

function extractEnabledPlugins(parsed: unknown): Record<string, boolean> | null {
  if (!parsed || typeof parsed !== 'object') return null
  const value = (parsed as Record<string, unknown>)[ENABLED_PLUGINS_KEY]
  if (!value || typeof value !== 'object') return null
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v
  }
  return out
}

/**
 * Two-key lookup: the caller may have used the OpenCC id
 * (e.g. `demo@marketplace`) OR the canonical manifest name (e.g. `demo`)
 * to disable a plugin. Either disables it.
 *
 * If the key is missing from `enabledPlugins`, the plugin stays enabled
 * (matches OpenCC's default-enable behaviour).
 */
function isEnabled(
  sourceRef: string,
  candidate: PluginCandidate,
  enabledPlugins: Record<string, boolean>,
): boolean {
  const idValue = enabledPlugins[sourceRef]
  if (typeof idValue === 'boolean') return idValue
  const nameValue = enabledPlugins[candidate.id]
  if (typeof nameValue === 'boolean') return nameValue
  return true
}

async function directoryExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch (cause) {
    if (isEnoent(cause)) return false
    throw cause
  }
}

async function readFileOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8')
  } catch (cause) {
    if (isEnoent(cause)) return null
    throw cause
  }
}

async function readJsonIfPresent(p: string): Promise<unknown | null> {
  const raw = await readFileOrNull(p)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}

function serializeCaught(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    }
  }
  if (typeof err === 'object') {
    try {
      return JSON.parse(JSON.stringify(err))
    } catch {
      return String(err)
    }
  }
  return err
}