import { readFile, readdir, realpath } from 'fs/promises'
import { join } from 'path'
import { readPluginManifest } from '../manifest.js'
import type {
  PluginCandidate,
  PluginCandidateResult,
  PluginLoadError,
} from '../types.js'

export type LoadZaiInput = {
  pluginsDir: string
  /**
   * Optional settings file path. When provided, the file's
   * `enabledPlugins` map is merged on top of `enabledPlugins` (later
   * wins). ENOENT is treated as "no overrides" — every discovered
   * plugin stays enabled unless explicitly disabled.
   */
  settingsPath?: string
  /**
   * Optional explicit enable/disable map. Lookup accepts BOTH the
   * canonical manifest name AND the directory basename (so users can
   * disable a plugin before its manifest has been read). Missing keys
   * default to enabled.
   */
  enabledPlugins?: Record<string, boolean>
}

/**
 * Scan `pluginsDir` for direct subdirectories and produce ZAI plugin
 * candidates from each.
 *
 * Disable filter resolution order:
 *   1. Caller-supplied `enabledPlugins` (always honored).
 *   2. `settingsPath`'s `enabledPlugins` field (if file is present).
 *   3. Default: every discovered plugin is enabled.
 *
 * Per-subdirectory manifest failures are isolated — they surface as
 * structured errors in the result without blocking the rest.
 */
export async function loadZaiPluginCandidates(
  input: LoadZaiInput,
): Promise<PluginCandidateResult> {
  const { pluginsDir, settingsPath, enabledPlugins } = input
  const errors: PluginLoadError[] = []
  const candidates: PluginCandidate[] = []

  let entries: string[]
  try {
    entries = await readdir(pluginsDir)
  } catch (cause) {
    if (isEnoent(cause)) {
      return { candidates: [], errors: [] }
    }
    errors.push({
      code: 'zai_plugins_unreadable',
      message: `Failed to read ZAI plugins directory ${pluginsDir}.`,
      source: 'zai',
      path: pluginsDir,
      detail: serializeCaught(cause),
    })
    return { candidates: [], errors }
  }

  const fileEnabled = await readSettingsEnabledPlugins(settingsPath, errors)
  const merged: Record<string, boolean> = { ...fileEnabled, ...(enabledPlugins ?? {}) }

  for (const name of entries) {
    if (name.startsWith('.')) continue
    const subdirPath = join(pluginsDir, name)
    const candidate = await buildCandidate(name, subdirPath, errors)
    if (candidate && isEnabled(name, candidate, merged)) {
      candidates.push(candidate)
    }
  }

  return { candidates, errors }
}

async function buildCandidate(
  dirName: string,
  subdirPath: string,
  errors: PluginLoadError[],
): Promise<PluginCandidate | null> {
  let realSubdir: string
  try {
    realSubdir = await realpath(subdirPath)
  } catch {
    return null
  }

  const statResult = await safeStatDir(realSubdir)
  if (!statResult) return null

  const manifestResult = await readPluginManifest(realSubdir)
  if (manifestResult.error || !manifestResult.manifest) {
    if (manifestResult.error) errors.push(manifestResult.error)
    return null
  }

  return {
    id: manifestResult.manifest.name,
    name: manifestResult.manifest.name,
    source: 'zai',
    sourceRef: manifestResult.manifest.name,
    root: realSubdir,
    manifest: manifestResult.manifest,
  }
}

async function safeStatDir(p: string): Promise<boolean> {
  const { stat } = await import('fs/promises')
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch (cause) {
    if (isEnoent(cause)) return false
    throw cause
  }
}

/**
 * Two-key lookup: the caller may have used the manifest name OR the
 * directory basename to disable a plugin. Either disables it.
 */
function isEnabled(
  dirName: string,
  candidate: PluginCandidate,
  enabledPlugins: Record<string, boolean>,
): boolean {
  const nameValue = enabledPlugins[candidate.id]
  if (typeof nameValue === 'boolean') return nameValue
  const dirValue = enabledPlugins[dirName]
  if (typeof dirValue === 'boolean') return dirValue
  return true
}

async function readSettingsEnabledPlugins(
  settingsPath: string | undefined,
  errors: PluginLoadError[],
): Promise<Record<string, boolean>> {
  if (!settingsPath) return {}
  let raw: string
  try {
    raw = await readFile(settingsPath, 'utf8')
  } catch (cause) {
    if (isEnoent(cause)) return {}
    errors.push({
      code: 'zai_settings_unreadable',
      message: `Failed to read ZAI settings file ${settingsPath}.`,
      source: 'zai',
      path: settingsPath,
      detail: serializeCaught(cause),
    })
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    const out = extractEnabledPlugins(parsed)
    return out ?? {}
  } catch (cause) {
    errors.push({
      code: 'zai_settings_invalid',
      message: `Failed to parse JSON at ${settingsPath}.`,
      source: 'zai',
      path: settingsPath,
      detail: serializeCaught(cause),
    })
    return {}
  }
}

function extractEnabledPlugins(parsed: unknown): Record<string, boolean> | null {
  if (!parsed || typeof parsed !== 'object') return null
  const value = (parsed as Record<string, unknown>).enabledPlugins
  if (!value || typeof value !== 'object') return null
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v
  }
  return out
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