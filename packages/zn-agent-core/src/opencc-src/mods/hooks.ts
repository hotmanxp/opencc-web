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
import { clearAllCaches } from '../utils/plugins/cacheUtils.js'
import {
  getUserConfigJson,
  setUserConfigJsonValue,
} from '../utils/userConfigJson.js'
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
  noteDiscoveredMod,
  clearKnownMods,
  type LoadedMod,
} from './registry.js'
import { isModEnabled, modPluginId } from './pluginView.js'
import { buildModHookMatchers } from './dispatch.js'
import { loadBuiltinMods, isBuiltinMod, isBuiltinModName } from './builtin.js'
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
  /**
   * zai patch (2026-10-10, mods 同步):被用户在插件列表关掉的 mod 记为
   * `ok: true, disabled: true` —— 它不是加载失败,只是没跑。它仍会出现在
   * 列表里(灰态),否则关掉就没有控件能打开。
   */
  disabled?: boolean
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

async function loadSingleMod(root: string): Promise<LoadedMod | null> {
  const manifestRaw = JSON.parse(
    await readFile(join(root, MOD_MANIFEST_FILE), 'utf8'),
  )
  const manifest = ModManifestSchema().parse(manifestRaw)
  // zai patch (2026-10-10, mods 同步):用户在插件列表关掉 mod 时的早退。
  // 门禁放在动态 import 之前 —— 被关掉的 mod 的顶层代码在本进程里一次都
  // 不该跑(加载器无沙箱),所以「未注册」必须等于「未执行」,而不只是
  // 「没接上」。此时仍要 noteDiscoveredMod:被关掉的 mod 必须以灰态出现
  // 在列表里,否则用户关掉之后就没有任何控件能再打开它。记在这里而不是
  // 门禁之前,是为了让随后校验失败的 mod 不进列表 —— 坏掉的 mod 以
  // 「健康已启用」的样子出现比不出现更糟。
  if (!isModEnabled(manifest.name, false)) {
    noteDiscoveredMod(manifest.name, false, manifest.userConfig, {
      description: manifest.description,
      version: manifest.version,
      root,
    })
    return null
  }

  await validateModRootReadable(manifest.name, root)
  const entryReal = await validateEntryPath(manifest.name, root, manifest.entry)
  await validateModSize(manifest.name, root)
  await validateModImports(manifest.name, root)

  // 过校验之后:从此处起,即便 register() 抛错也要能被列出 —— 用户需要
  // 看见它才知道自己的 mod 坏了。
  noteDiscoveredMod(manifest.name, false, manifest.userConfig, {
    description: manifest.description,
    version: manifest.version,
    root,
  })

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
  // zai patch (2026-10-10, mods 同步):每轮重新发现 —— 被删掉的 mod 目录
  // 不该继续留在插件列表里。
  clearKnownMods()
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
      if (!mod) {
        // 在插件列表里被关掉了。名字从 loadSingleMod 已解析过的 manifest
        // 来 —— 那里已经读过一次,这里不重复走校验。
        results.push({ name: await readDisabledModName(root), ok: true, disabled: true })
        continue
      }
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
  for (const name of builtins.disabled) {
    // zai patch (2026-10-10, mods 同步):被用户停用的内置 mod 记为
    // ok+disabled(不是失败),并且不计入 loaded —— 它仍由 noteDiscoveredMod
    // 留在插件列表里,只是没有代码在跑。
    logForDebugging(`[mods] built-in "${name}" is disabled; skipped`)
    results.push({ name, ok: true, disabled: true })
  }
  for (const failure of builtins.failed) {
    results.push({ name: failure.name, ok: false, error: failure.error })
  }
  swapRegisteredHooks()

  const loaded = results.filter(r => r.ok && !r.disabled)
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

/**
 * zai patch (2026-10-10, mods 同步):取一个被禁用 mod 的 manifest 名。
 * 用于 loadMods 的早退分支 —— 那时 loadSingleMod 已经返回 null 且没把名字
 * 带出来,这里重新廉价地读一次 manifest,解析不了就退回目录名。
 */
async function readDisabledModName(root: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(join(root, MOD_MANIFEST_FILE), 'utf8'))
    const parsed = ModManifestSchema().safeParse(raw)
    if (parsed.success) return parsed.data.name
  } catch {
    // 落到目录名
  }
  return basename(root)
}

export type ModEnableResult = {
  success: boolean
  message: string
}

/**
 * 开关一个 mod —— 插件管理 UI 的开关最终落在这里。
 *
 * 与市场插件开关的关键差异:写完设置就已经生效了,所以不需要像插件那样
 * 回一句「跑 /reload-plugins」。设置写到 userSettings 下真插件用的同一个
 * `enabledPlugins` 键(`<modName>@builtin` / `<modName>@mods`)—— 这正是
 * 插件 UI 里的开关能读回正确值的原因。
 *
 * zai patch (2026-10-10, mods 同步):与上游一致 —— 立即生效而非等下次
 * 启动。关掉走 unloadMod(本会话内 handler 立刻停),打开走 reloadMods。
 */
export async function setModEnabled(
  modName: string,
  enabled: boolean,
): Promise<ModEnableResult> {
  // 来源要从声明的 builtin 名单解析,不能问注册表:正要打开的 mod 按定义
  // 就不在注册表里。
  const builtin = isBuiltinModName(modName)
  const pluginId = modPluginId(modName, builtin)

  // zai patch (2026-10-10, mods 同步):写入走 `setUserConfigJsonValue`,
  // 不是上游的 `updateSettingsForSource('userSettings', …)`。zai 已把
  // user 作用域的插件状态迁到统一 user config JSON(`~/.zai.json`,
  // 回退 `~/.zai.json`)—— 插件列表的 buildList() 读的就是那里。写去
  // settings.json 会让开关「看起来成功」但列表永远读不回新值。
  // 与 services/plugins/pluginOperations.ts:587 内置插件 fast path 同源。
  const { error } = setUserConfigJsonValue('enabledPlugins', {
    ...getUserConfigJson().enabledPlugins,
    [pluginId]: enabled,
  })
  if (error) {
    return {
      success: false,
      message: `Failed to ${enabled ? 'enable' : 'disable'} ${modName}: ${error.message}`,
    }
  }
  clearAllCaches()

  if (!enabled) {
    // 光写设置就够下次启动了;这里顺手卸掉,让本会话的 handler 也停下。
    await unloadMod(modName)
  } else {
    await reloadMods()
    if (!getLoadedMods().some(m => m.manifest.name === modName)) {
      return {
        success: false,
        message: `Enabled ${modName} in settings, but it failed to load. Run reload again and check the error log.`,
      }
    }
  }

  logForDebugging(`[mods] ${modName} ${enabled ? 'enabled' : 'disabled'} via ${pluginId}`)
  return {
    success: true,
    message: `${enabled ? 'Enabled' : 'Disabled'} ${modName}`,
  }
}

/** Reset module state. For tests only. */
export function resetModsLoaderForTesting(): void {
  unregisterModHookMatchers(registeredMatcherRefs)
  registeredMatcherRefs = []
  loadMods.cache?.clear?.()
}
