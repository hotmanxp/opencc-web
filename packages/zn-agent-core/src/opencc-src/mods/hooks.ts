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

async function loadSingleMod(root: string): Promise<LoadedMod> {
  const manifestRaw = JSON.parse(
    await readFile(join(root, MOD_MANIFEST_FILE), 'utf8'),
  )
  const manifest = ModManifestSchema().parse(manifestRaw)
  await validateModRootReadable(manifest.name, root)
  const entryReal = await validateEntryPath(manifest.name, root, manifest.entry)
  await validateModSize(manifest.name, root)
  await validateModImports(manifest.name, root)

  const module = (await import(pathToFileURL(entryReal).href)) as {
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
  await module.register(createModContext(mod))
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
  ensureBreakerWired()
  const dir = getModsDirectory()
  // Drop previous instances first — /mods reload must not duplicate
  // handlers (disk and built-in mods alike).
  for (const mod of [...getLoadedMods()]) {
    unregisterMod(mod.manifest.name)
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
export async function unloadMod(name: string): Promise<boolean> {
  const removed = unregisterMod(name)
  if (!removed) return false
  // Clear the persistent ui.status segment the mod left behind.
  // zai patch (2026-10-06):原 opencc 还在这里调 clearModPanes(name) ——
  // pane 是 TUI render site,已随 Web UI 体系删除,无残留可清。
  clearModStatus(name)
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
