import { writeFile, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { OutputStyle, Theme, ZaiSettings } from '../../shared/settings.js'
import { getCachedZaiSettings, refreshCache } from './zaiSettingsCache.js'

// Re-export the cache API so existing `zaiSettingsStore` importers can reach
// it without a second import path.
export {
  getCachedZaiSettings,
  getCachedZaiSettingsSync,
  initZaiSettingsCache,
  __resetCacheForTests,
} from './zaiSettingsCache.js'

/** Path to ~/.zai/settings.json — the on-disk persistence layer. */
export function zaiSettingsPath(): string {
  return join(homedir(), '.zai', 'settings.json')
}

/**
 * Read the cached ~/.zai/settings.json value. Backed by the boot-time
 * settings cache (see zaiSettingsCache.ts): returns the resolved settings
 * once `initZaiSettingsCache()` has run, awaiting initialization if a caller
 * arrives before it settles. The three-tier fallback (zai → claude → builtin
 * defaults) guarantees a valid object, so this never throws on a missing file.
 */
export async function readZaiSettings(): Promise<ZaiSettings> {
  return getCachedZaiSettings()
}

/**
 * Atomically write the given object to ~/.zai/settings.json. Uses
 * tmp+rename so a crash mid-write never corrupts the user's settings,
 * then synchronously refreshes the in-memory cache so subsequent reads
 * (this process) see the new value immediately — no watcher, no restart.
 */
export async function writeZaiSettings(settings: ZaiSettings): Promise<void> {
  const path = zaiSettingsPath()
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf-8')
  await rename(tmpPath, path)
  refreshCache(settings)
}

const VALID_OUTPUT_STYLES: ReadonlySet<OutputStyle> = new Set<OutputStyle>([
  'default',
  'compact',
  'verbose',
])

/**
 * Resolve the persisted output style with validation. Unknown / missing
 * values collapse to 'default' so a hand-edited settings.json can never
 * leave the UI stuck in an unrenderable state.
 */
export function resolveOutputStyle(settings: ZaiSettings): OutputStyle {
  const candidate = settings.outputStyle
  if (typeof candidate === 'string' && VALID_OUTPUT_STYLES.has(candidate as OutputStyle)) {
    return candidate as OutputStyle
  }
  return 'default'
}

/** Validate a candidate style value before persisting. */
export function isValidOutputStyle(value: unknown): value is OutputStyle {
  return typeof value === 'string' && VALID_OUTPUT_STYLES.has(value as OutputStyle)
}

const VALID_THEMES: ReadonlySet<Theme> = new Set<Theme>([
  'auto',
  'dark',
  'light',
  'high-contrast',
])

/**
 * Resolve the persisted theme with validation. Unknown / missing values
 * collapse to 'dark' (project default) so a hand-edited settings.json can
 * never leave the UI stuck in an unrenderable state. Mirrors resolveOutputStyle().
 */
export function resolveTheme(settings: ZaiSettings): Theme {
  const candidate = settings.theme
  if (typeof candidate === 'string' && VALID_THEMES.has(candidate as Theme)) {
    return candidate as Theme
  }
  return 'dark'
}

/** Validate a candidate theme value before persisting. */
export function isValidTheme(value: unknown): value is Theme {
  return typeof value === 'string' && VALID_THEMES.has(value as Theme)
}

/**
 * Resolve the persisted "default split screen" flag with validation.
 * Unknown / missing values collapse to false so a hand-edited
 * settings.json can never leave the UI in an unrenderable state.
 *
 * Used by GET /api/agent/settings to feed SettingsDrawer and by
 * SplitPane / Agent.tsx as the first-run seed for the split-pane
 * open state in localStorage. Users who manually toggle split-pane
 * in the UI get an explicit localStorage override that wins over
 * this default — see SplitPane.tsx first-run seed effect.
 */
export function resolveDefaultSplitScreen(settings: ZaiSettings): boolean {
  return settings.defaultSplitScreen === true
}

/** Validate a candidate default-split-screen value before persisting. */
export function isValidDefaultSplitScreen(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

/**
 * Resolve the persisted "enable dynamic workflow" flag with validation.
 * Unknown / missing values collapse to false — workflows stay opt-in.
 *
 * The setting is the zai-side mirror of vendor's `OPENCC_ENABLE_WORKFLOWS`
 * env var: `enableDynamicWorkflow === true` maps to env=1 in the PUT route,
 * and `enableOpenccConfigs()` does the same bridge on boot. The vendor
 * `isWorkflowsDisabled()` check at `getAllBaseTools()` consults the env
 * var first, so a runtime toggle takes effect on the next `query()` call
 * without restarting the process.
 */
export function resolveEnableDynamicWorkflow(settings: ZaiSettings): boolean {
  return settings.enableDynamicWorkflow === true
}

/** Validate a candidate enable-dynamic-workflow value before persisting. */
export function isValidEnableDynamicWorkflow(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

/**
 * Resolve the persisted "auto-update zai" flag with validation.
 * Unknown / missing values collapse to true — we want new users to get
 * silent auto-updates by default. SettingsDrawer is the explicit opt-out.
 *
 * The setting gates `maybeAutoUpdate()` in services/updater.ts: on every
 * boot, fire-and-forget; if disabled, no `npm view`, no `npm install -g`,
 * no SSE events — completely silent.
 */
export function resolveAutoUpdate(settings: ZaiSettings): boolean {
  return settings.autoUpdate !== false
}

/** Validate a candidate auto-update value before persisting. */
export function isValidAutoUpdate(value: unknown): value is boolean {
  return typeof value === 'boolean'
}