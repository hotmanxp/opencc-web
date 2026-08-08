import { readFile } from 'node:fs/promises'
import { readFileSync, watch as fsWatch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_DEFAULT_SETTINGS, type ZaiSettings } from '../../shared/settings.js'
import { writeZaiSettings, zaiSettingsPath } from './zaiSettingsStore.js'

/**
 * Boot-time settings cache with three-tier fallback.
 *
 * `createApp()` calls `initZaiSettingsCache()` once at boot to resolve
 * ~/.zai/settings.json by tier:
 *   1. ~/.zai/settings.json exists + valid JSON  → use it
 *   2. else ~/.zai/settings.json exists+valid → seed it into ~/.zai, use it
 *   3. else BUILTIN_DEFAULT_SETTINGS             → seed it into ~/.zai, use it
 *
 * All read paths then hit the in-memory cache (zero disk I/O) via
 * `getCachedZaiSettings()` / `getCachedZaiSettingsSync()`. The write path
 * (`writeZaiSettings`) calls `refreshCache()` so the cache stays in sync.
 *
 * zai patch: a `fs.watch` on `~/.zai/settings.json` is installed once
 * at init time so external edits to the file (e.g. the user setting
 * `ANTHROPIC_AUTH_TOKEN` from a different terminal while zai dev is
 * running) reach the cache without a full restart. Watcher debounces
 * 50ms to coalesce multi-event editor saves. The previous
 * "zai is sole writer" assumption was wrong — AGENTS.md flags sub-agents
 * sometimes writing settings too, plus the user themselves. Without
 * hot-reload, the `sess-ebb7834a-...json → 403` only clears on a
 * restart even though the fix to `modelCaller.ts` was already correct.
 *
 * See docs/superpowers/specs/2026-07-23-zai-settings-boot-cache-design.md.
 */

/** Path to ~/.zai/settings.json — the tier-2 seed source. */
function claudeSettingsPath(): string {
  return join(homedir(), '.zai', 'settings.json')
}

let cached: ZaiSettings | undefined
let initPromise: Promise<void> | undefined
let watcherStop: (() => void) | undefined
let watcherDebounceMs = 50

function installWatcher(): void {
  if (watcherStop) return
  // Watch the file zai-server actually reads. `recursive: false` is enough
  // because the path is a single file — false alarms from some editors'
  // double-fire (write + rename) are coalesced by the debounce below.
  let timer: NodeJS.Timeout | undefined
  try {
    const handle = fsWatch(zaiSettingsPath(), { persistent: false }, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        try {
          const raw = readFileSync(zaiSettingsPath(), 'utf-8')
          const parsed = JSON.parse(raw) as ZaiSettings
          cached = parsed
          if (process.env.ZAI_DEBUG === '1') {
            console.warn('[zai-settings-cache] hot-reloaded from disk:', zaiSettingsPath())
          }
        } catch (err) {
          // Partial-write or stale event — keep cache untouched so the
          // current boot-time settings keep working until the editor
          // settles and a follow-up change event arrives.
          if (process.env.ZAI_DEBUG === '1') {
            console.warn('[zai-settings-cache] hot-reload failed:', (err as Error).message)
          }
        }
      }, watcherDebounceMs)
    })
    watcherStop = () => {
      handle.close()
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      watcherStop = undefined
    }
  } catch (err) {
    // File may not exist yet (the tier chain hasn't run). Skip silently —
    // the next settings write (via writeZaiSettings) reinstalls the watcher
    // through `refreshCache` hook? No — refreshCache only updates `cached`,
    // it doesn't touch the watcher. If the file is created later via the
    // tier-2/tier-3 seed-write path, we miss subsequent hot-reloads. The
    // boot-time init triggers runInit which calls installWatcher; tier
    // seeds that write later won't restart watching. Acceptable: rare
    // scenario, and the operator workaround is a server restart.
    if (process.env.ZAI_DEBUG === '1') {
      console.warn('[zai-settings-cache] watcher install failed:', (err as Error).message)
    }
  }
}

/**
 * Read + parse a JSON settings file. Returns `undefined` on ENOENT or
 * invalid JSON (a miss that falls through to the next tier); re-throws any
 * other IO error so a genuine disk fault surfaces instead of silently
 * reseeding the user's settings.
 */
async function tryReadSettings(path: string): Promise<ZaiSettings | undefined> {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as ZaiSettings
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (err instanceof SyntaxError) return undefined
    throw err
  }
}

async function runInit(): Promise<void> {
  // Tier 1: ~/.zai/settings.json. A real IO error (not ENOENT/SyntaxError)
  // propagates — that's a bug signal, not a missing-file condition.
  const tier1 = await tryReadSettings(zaiSettingsPath())
  if (tier1 !== undefined) {
    cached = tier1
    return
  }

  // Tier 2: ~/.zai/settings.json → seed into ~/.zai. A read failure here
  // is non-fatal: warn and fall through to tier 3 rather than block boot.
  let tier2: ZaiSettings | undefined
  try {
    tier2 = await tryReadSettings(claudeSettingsPath())
  } catch (err) {
    console.warn('[zai-settings-cache] tier-2 read failed:', err)
  }
  if (tier2 !== undefined) {
    cached = tier2
    await writeZaiSettings(tier2).catch((e) =>
      console.warn('[zai-settings-cache] tier-2 seed write failed:', e),
    )
    return
  }

  // Tier 3: builtin defaults → seed into ~/.zai.
  cached = BUILTIN_DEFAULT_SETTINGS
  await writeZaiSettings(BUILTIN_DEFAULT_SETTINGS).catch((e) =>
    console.warn('[zai-settings-cache] tier-3 seed write failed:', e),
  )
}

/**
 * Idempotent boot initialization. Concurrent callers share a single in-flight
 * promise so the tier chain runs at most once per process.
 */
export function initZaiSettingsCache(): Promise<void> {
  if (!initPromise) {
    initPromise = runInit().finally(() => {
      installWatcher()
    })
  }
  return initPromise
}

/** Manually tear down the file watcher (used by tests + graceful shutdown). */
export function stopZaiSettingsWatcher(): void {
  watcherStop?.()
}

/** Async read. Awaits initialization if it has not completed yet. */
export async function getCachedZaiSettings(): Promise<ZaiSettings> {
  if (cached === undefined) {
    await initZaiSettingsCache()
  }
  return cached ?? {}
}

/**
 * Sync read. Returns the cached value when initialization has settled.
 * Before that (the brief boot window) — or in tests that drive settings via
 * fs/homedir mocks — it falls back to a synchronous disk read of
 * ~/.zai/settings.json, exactly matching the legacy per-module
 * `readZaiSettings()` behavior (missing/invalid → {}). Once
 * `initZaiSettingsCache()` resolves, `cached` is set and this fallback path
 * is never hit again, so steady-state reads are zero disk I/O.
 */
export function getCachedZaiSettingsSync(): ZaiSettings {
  if (cached !== undefined) return cached
  try {
    return JSON.parse(readFileSync(zaiSettingsPath(), 'utf-8')) as ZaiSettings
  } catch {
    return {}
  }
}

/** Write-path hook: atomically replace the cached value after a disk write. */
export function refreshCache(value: ZaiSettings): void {
  cached = value
}

/** Test hook: clear module-level state so each test re-runs the tier chain. */
export function __resetCacheForTests(): void {
  cached = undefined
  initPromise = undefined
  watcherStop?.()
  watcherStop = undefined
}
