import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { OutputStyle, ZaiSettings } from '../../shared/settings.js'

/** Path to ~/.zai/settings.json — the on-disk persistence layer. */
export function zaiSettingsPath(): string {
  return join(homedir(), '.zai', 'settings.json')
}

/**
 * Read ~/.zai/settings.json as an untyped object. Returns {} when the file
 * is missing or unparseable so callers can keep working.
 *
 * Mirrors the defensive pattern used in modelCaller / permissionMode /
 * agentSettings — the file is optional and the server must stay up when
 * it is absent.
 */
export async function readZaiSettings(): Promise<ZaiSettings> {
  try {
    const raw = await readFile(zaiSettingsPath(), 'utf-8')
    return JSON.parse(raw) as ZaiSettings
  } catch (err) {
    if (err instanceof SyntaxError) return {}
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

/**
 * Atomically write the given object to ~/.zai/settings.json. Uses
 * tmp+rename so a crash mid-write never corrupts the user's settings.
 *
 * `ensureDir` mirrors the writeConfig helper in fileStore.ts: directory
 * creation is best-effort and the rename step requires the parent to
 * exist already on most filesystems.
 */
export async function writeZaiSettings(settings: ZaiSettings): Promise<void> {
  const path = zaiSettingsPath()
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf-8')
  await rename(tmpPath, path)
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