import { writeFile, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { OutputStyle, ZaiSettings } from '../../shared/settings.js'
import { getCachedZaiSettings, refreshCache } from './zaiSettingsCache.js'

// Re-export the cache API so existing `zaiSettingsStore` importers can reach
// it without a second import path.
export {
  getCachedZaiSettings,
  getCachedZaiSettingsSync,
  initZaiSettingsCache,
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