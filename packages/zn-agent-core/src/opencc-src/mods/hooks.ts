import memoize from 'lodash-es/memoize.js'
import { basename, join } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { registerHookCallbacks, unregisterHookMatchers } from '../bootstrap/state.js'
import type { HookCallbackMatcher } from '../types/hooks.js'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { expandTilde } from '../utils/permissions/pathValidation.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { skillChangeDetector } from '../utils/skills/skillChangeDetector.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../services/analytics/index.js'
import { ModManifestSchema, MOD_MANIFEST_FILE } from './manifest.js'
import {
  registerLoadedMod,
  getLoadedMods,
  unregisterMod,
  registerModBreakerListener,
  type LoadedMod,
} from './registry.js'
import { buildModHookMatchers } from './dispatch.js'
import { loadBuiltinMods, isBuiltinMod } from './builtin.js'
import {
  createModContext,
  clearModStatus,
  emitModsSystemNotice,
} from './engine.js'
import {
  ModValidationError,
  validateEntryPath,
  validateModImports,
  validateModRootReadable,
  validateModSize,
} from './validate.js'

/**
 * Mods integration (docs/mods-plan.md §3.4 hooks.ts).
 *
 * Loading model mirrors plugin hooks (src/utils/plugins/loadPluginHooks.ts):
 * memoized loader, awaited by processSessionStartHooks BEFORE SessionStart
 * hooks execute, registered into the global registry via registerHookCallbacks
 * so every stock executor sees mod handlers. Per-mod failures are attributed
 * and skipped — one broken mod never blocks the others or the session.
 */

export const OPENCC_MODS_DIR_ENV = 'OPENCC_MODS_DIR'

/** Env override → default `<config-home>/mods` (getPluginsDirectory parity). */
export function getModsDirectory(): string {
  const envOverride = process.env[OPENCC_MODS_DIR_ENV]
  if (envOverride) {
    return expandTilde(envOverride)
  }
  return join(getClaudeConfigHomeDir(), 'mods')
}

export type ModLoadResult = {
  name: string
  ok: boolean
  error?: string
}

// Identity refs of the HookCallbackMatchers we pushed into the global
// registry — the exact set we remove on unload/reload (see unregisterHookMatchers).
let registeredMatcherRefs: HookCallbackMatcher[] = []

async function discoverModRoots(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const roots: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const root = join(dir, entry.name)
    try {
      await readFile(join(root, MOD_MANIFEST_FILE), 'utf8')
      roots.push(root)
    } catch {
      // no manifest — not a mod dir
    }
  }
  return roots.sort()
}

/**
 * Cache-buster appended to a mod entry's import specifier.
 *
 * ESM caches a module by resolved URL forever, so `/mods reload` after editing
 * a mod's source kept running the OLD code — the reload appeared to succeed
 * and nothing changed (oc-002). A query string makes each pass a distinct URL.
 *
 * It has to bump on every reload, not just once: the counter is what makes the
 * *next* reload different from the previous one's cached copy.
 */
let modReloadGeneration = 0

function reloadQuerySuffix(): string {
  return `?openccReload=${modReloadGeneration}`
}

async function loadSingleMod(root: string): Promise<LoadedMod> {
  const manifestRaw = JSON.parse(
    await readFile(join(root, MOD_MANIFEST_FILE), 'utf8'),
  )
  const manifest = ModManifestSchema().parse(manifestRaw)
  await validateModRootReadable(manifest.name, root)
  const entryReal = await validateEntryPath(manifest.name, root, manifest.entry)
  await validateModSize(manifest.name, root)
  await validateModImports(manifest.name, root)

  const module = (await import(pathToFileURL(entryReal).href + reloadQuerySuffix())) as {
    register?: unknown
  }
  if (typeof module.register !== 'function') {
    throw new ModValidationError(
      'mod entry must export a `register(ctx)` function',
      manifest.name,
    )
  }
  const mod: LoadedMod = {
    manifest,
    root,
    entryPath: entryReal,
    handlers: [],
    commands: [],
    tools: [],
  }
  const name = manifest.name
  try {
    await module.register(createModContext(mod))
  } catch (error) {
    // A mod can claim ui.status (and ui.pane upstream) before it throws. Those
    // live in registries keyed by mod name, and this mod never gets registered,
    // so no unload or reload path would ever clear them — leaving a broken
    // mod's UI behind permanently (oc-001). Release what it claimed.
    // zai patch: pane 在本 vendor 已随 TUI 能力面删除,只剩 status。
    clearModStatus(name)
    throw error
  }
  return mod
}

function swapRegisteredHooks(): void {
  unregisterModHookMatchers(registeredMatcherRefs)
  const { byEvent, refs } = buildModHookMatchers(getLoadedMods())
  registeredMatcherRefs = refs
  if (refs.length > 0) {
    registerHookCallbacks(byEvent)
  }
  // Mod commands/tools may have changed — refresh consumers that build
  // command lists at startup (REPL useSkillsChange re-fetches on this signal).
  skillChangeDetector.notifyCommandsChanged()
}

export const loadMods = memoize(async (): Promise<ModLoadResult[]> => {
  // Fresh import specifiers for this pass so edited mod code actually runs.
  modReloadGeneration++
  ensureBreakerWired()
  const dir = getModsDirectory()
  // Drop previous instances first — /mods reload must not duplicate
  // handlers (disk and built-in mods alike).
  for (const mod of [...getLoadedMods()]) {
    purgeModState(mod.manifest.name)
  }
  let roots: string[]
  try {
    roots = await discoverModRoots(dir)
  } catch {
    // mods dir missing/unreadable — disk mods are optional; built-ins
    // still load below (they have no dependency on the mods directory).
    roots = []
  }
  if (roots.length === 0) {
    logForDebugging(`[mods] no disk mods found in ${dir}; built-ins still register`)
  }

  const results: ModLoadResult[] = []
  for (const root of roots) {
    const fallbackName = basename(root)
    try {
      const mod = await loadSingleMod(root)
      registerLoadedMod(mod)
      logForDebugging(
        `[mods] loaded "${mod.manifest.name}" (${mod.handlers.length} handlers, ${mod.tools.length} tools, ${mod.commands.length} commands)`,
      )
      results.push({ name: mod.manifest.name, ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logForDebugging(`[mods] failed to load mod at ${root}: ${message}`)
      results.push({ name: fallbackName, ok: false, error: message })
    }
  }
  // Built-in mods (in-memory channel, upstream registerScan parity) —
  // registered after disk mods so a disk mod can shadow a built-in name.
  const builtins = await loadBuiltinMods()
  for (const mod of builtins.loaded) {
    results.push({ name: mod.manifest.name, ok: true })
    logForDebugging(
      `[mods] built-in "${mod.manifest.name}" registered (${mod.handlers.length} handlers, ${mod.commands.length} commands)`,
    )
  }
  for (const failure of builtins.failed) {
    results.push({ name: failure.name, ok: false, error: failure.error })
  }
  swapRegisteredHooks()

  const loaded = results.filter(r => r.ok)
  const failed = results.filter(r => !r.ok)
  const builtinCount = loaded.filter(name => isBuiltinLoadedName(name.name)).length
  const meta = (v: string) =>
    v as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  logEvent(`tengu_mods_load`, {
    loaded: meta(String(loaded.length)),
    failed: meta(String(failed.length)),
    builtin: meta(String(builtinCount)),
    names: meta(jsonStringify(loaded.map(r => r.name))),
  })

  return results
})

function isBuiltinLoadedName(name: string): boolean {
  return getLoadedMods().some(
    m => m.manifest.name === name && isBuiltinMod(m),
  )
}

// --- Circuit breaker (P2): consecutive handler failures auto-unload a mod --
let breakerWired = false
function ensureBreakerWired(): void {
  if (breakerWired) return
  breakerWired = true
  registerModBreakerListener((modName, failures) => {
    logForDebugging(
      `[mods] circuit breaker: disabling mod "${modName}" after ${failures} consecutive handler failures`,
    )
    logEvent(`tengu_mods_circuit_break`, {
      mod: modName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      failures: Number(failures),
    })
    void unloadMod(modName).then(removed => {
      if (removed) {
        emitModsSystemNotice(
          `Mod "${modName}" disabled after ${failures} consecutive errors`,
        )
      }
    })
  })
}

/** Minimal unload (P1, docs R9): remove a mod and rebuild the hook swap. */
/**
 * Drop every trace of a mod from the runtime.
 *
 * The single cleanup point for mod-owned state. Registration writes into
 * several independent registries (statuses, panes, the render cache, the
 * circuit-breaker count), so anything that removes a mod must call this —
 * unloading and reloading are both removals, and having only one of them do
 * the cleanup is what let a reload leave a stale status segment behind
 * (tc-004).
 */
function purgeModState(name: string): void {
  // zai patch (2026-10-06): pane 是 TUI render site,已随 Web UI 体系删除,
  // 本 vendor 无 pane 注册表,故只清 status。
  clearModStatus(name)
  // The render cache and breaker count are keyed by mod registration, so they
  // clear when the mod leaves the registry — see registry.unregisterMod.
  unregisterMod(name)
}

export async function unloadMod(name: string): Promise<boolean> {
  if (!getLoadedMods().some(m => m.manifest.name === name)) return false
  purgeModState(name)
  swapRegisteredHooks()
  logForDebugging(`[mods] unloaded mod "${name}"`)
  return true
}

function unregisterModHookMatchers(toRemove: HookCallbackMatcher[]): void {
  if (toRemove.length === 0) return
  // Lives in bootstrap/state.ts to keep STATE encapsulated there.
  unregisterHookMatchers(toRemove)
}

/** Reload all mods (clear memoize, drop old hooks, load fresh). */
export async function reloadMods(): Promise<ModLoadResult[]> {
  unregisterModHookMatchers(registeredMatcherRefs)
  registeredMatcherRefs = []
  loadMods.cache?.clear?.()
  return loadMods()
}

/** Reset module state. For tests only. */
export function resetModsLoaderForTesting(): void {
  unregisterModHookMatchers(registeredMatcherRefs)
  registeredMatcherRefs = []
  loadMods.cache?.clear?.()
}
