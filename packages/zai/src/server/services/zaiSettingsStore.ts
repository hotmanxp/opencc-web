import { writeFile, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { CoreRuntime, OutputStyle, Theme, WorkMode, ZaiSettings } from '../../shared/settings.js'
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
 * In-process serialisation chain for every settings.json mutation.
 *
 * Why: `writeZaiSettings` is tmp+rename, and the tmp path is a fixed
 * `${path}.tmp`. Concurrent PUTs (e.g. SettingsDrawer's work-mode effect
 * firing `work-mode` + `main-agent` back-to-back, or Desktop.tsx's office
 * auto-switch racing a manual theme change) used to interleave
 * writeFile/rename on the same tmp file — the first rename consumes it and
 * the second rename fails with `ENOENT ... settings.json.tmp -> settings.json`
 * (500 to the client, and the loser's update dropped).
 *
 * The chain makes each mutation atomic w.r.t. the others: only one task
 * touches disk (and the cache) at a time. A rejected task must not break
 * the chain, so both handlers continue.
 */
let mutationChain: Promise<unknown> = Promise.resolve()

function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(task, task)
  mutationChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Atomically write the given object to ~/.zai/settings.json (unlocked —
 * only call from inside an `enqueueMutation` task). Uses tmp+rename so a
 * crash mid-write never corrupts the user's settings, then synchronously
 * refreshes the in-memory cache so subsequent reads (this process) see
 * the new value immediately — no watcher, no restart.
 */
async function writeZaiSettingsUnlocked(settings: ZaiSettings): Promise<void> {
  const path = zaiSettingsPath()
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf-8')
  await rename(tmpPath, path)
  refreshCache(settings)
}

/**
 * Queue-based wrapper around `writeZaiSettingsUnlocked`. Whole-object
 * writes are serialised against `updateZaiSettings` patches, so a full
 * overwrite can never interleave with a read-merge-write.
 */
export function writeZaiSettings(settings: ZaiSettings): Promise<void> {
  return enqueueMutation(() => writeZaiSettingsUnlocked(settings))
}

/**
 * Read-merge-write a partial patch against the current settings, with the
 * whole critical section (cached read → merge → tmp+rename write) running
 * inside the mutation queue. This is the race-free path for routes that
 * only change one field: the read always sees the result of every
 * previously-queued write, so concurrent patches to different keys both
 * land (no lost update, no fixed-tmp ENOENT).
 *
 * Returns the merged object that was persisted, so the caller can echo
 * canonical values back to the client.
 */
export async function updateZaiSettings(
  patch: Partial<ZaiSettings>,
): Promise<ZaiSettings> {
  // Warm the boot-time cache BEFORE taking the queue. First-touch cache
  // init runs the tier chain, whose permissions backfill itself awaits
  // `writeZaiSettings` — if that happened from inside a queued task the
  // task would enqueue behind itself and deadlock.
  await getCachedZaiSettings()
  return enqueueMutation(async () => {
    // Cache is initialised now, so this resolves without re-entering init.
    const settings = await getCachedZaiSettings()
    const next: ZaiSettings = { ...settings, ...patch }
    await writeZaiSettingsUnlocked(next)
    return next
  })
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

const VALID_WORK_MODES: ReadonlySet<WorkMode> = new Set<WorkMode>([
  'code',
  'office',
  'general',
])

/** Resolve the persisted working mode, defaulting to code. */
export function resolveWorkMode(settings: ZaiSettings): WorkMode {
  const candidate = settings.workMode
  if (typeof candidate === 'string' && VALID_WORK_MODES.has(candidate as WorkMode)) {
    return candidate as WorkMode
  }
  return 'code'
}

/** Validate a candidate working mode before persisting. */
export function isValidWorkMode(value: unknown): value is WorkMode {
  return typeof value === 'string' && VALID_WORK_MODES.has(value as WorkMode)
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

/**
 * zai patch (2026-08-28): 核心运行时三态设置开关。与 `agentRuntime.ts` 的
 * `resolveCoreRuntime` 语义对齐(env `ZAI_CORE_RUNTIME` / `--coreRuntime`
 * flag 优先级更高,不在此函数职责内):把持久化的 `settings.coreRuntime`
 * 归一化为 'default' | 'inproc' | 'spawn' 供 UI 渲染(缺失 / 非法 → 'default')。
 */
export function resolveCoreRuntime(
  settings: ZaiSettings,
): CoreRuntime {
  const s = settings.coreRuntime
  if (s === 'inproc' || s === 'spawn' || s === 'default') return s
  return 'default'
}

/** Validate a candidate coreRuntime value before persisting. */
export function isValidCoreRuntime(
  value: unknown,
): value is CoreRuntime {
  return value === 'default' || value === 'inproc' || value === 'spawn'
}

/**
 * zai patch (2026-08-29, plan §A): 解析 settings.openccCliDangerouslySkip
 * 持久化值。env `ZAI_DANGEROUSLY_SKIP_PERMISSIONS` 优先级更高（不在此函数职责内）：
 * 把 settings 字段归一化为 boolean（缺失 / 非法 → false）。
 */
export function resolveOpenccCliDangerouslySkip(
  settings: ZaiSettings,
): boolean {
  return settings.openccCliDangerouslySkip === true
}

/** Validate a candidate openccCliDangerouslySkip value before persisting. */
export function isValidOpenccCliDangerouslySkip(
  value: unknown,
): value is boolean {
  return typeof value === 'boolean'
}