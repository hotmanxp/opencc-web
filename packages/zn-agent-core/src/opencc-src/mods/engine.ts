import type { Tool } from '../Tool.js'
import { MCPTool } from '../tools/MCPTool/MCPTool.js'
import type { Command } from '../types/command.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import {
  loadPluginOptions,
  type PluginOptionValues,
} from '../utils/plugins/pluginOptionsStorage.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'
import { realpath, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  LoadedMod,
  ModCommandSpec,
  ModHandler,
  ModHandlerInput,
  ModToolSpec,
} from './registry.js'
import {
  BUILTIN_ORIGIN,
  getLoadedMods,
  getModToolsVersion,
  hasSessionModGate,
  isModVisibleForSession,
  type ModStreamEvent,
  type ModStreamHandler,
} from './registry.js'
import {
  dispatchModOp,
  dispatchModOpSync,
  subscribeModProgress,
} from './dispatch.js'
import {
  buildModNouns,
  type AncestorsArgs as ModAncestorsArgs,
  type FsAncestor,
  type ModClock,
  type ModEnv,
  type ModProcess,
  type ModState,
  type ModStore,
  type ModSession,
  type ModTelemetry,
  type ModSettings,
  type ModFlag,
  type ModHttp,
  type ModTool,
  type ModCommand,
  type ModAgent,
  type ModModel,
  type ModConfig,
  type ModPrompt,
} from './nouns.js'
import {
  INVALIDATABLE_EVENTS,
  MOD_EVENTS,
  isModEventName,
  splitTier,
  unavailabilityReason,
  type ModEventName,
  type ModMatcher,
  type ModNext,
} from './protocol.js'
import { modPluginId } from './pluginView.js'

/**
 * Upstream `ui.invalidate` — the only events a mod may name. A typo here would
 * otherwise silently redraw nothing. The set is the upstream one, unchanged.
 */
const INVALIDATE_EVENTS = new Set<string>(INVALIDATABLE_EVENTS)


/**
 * Mod runtime API surface (docs/mods-plan.md §3.3 "能力面 $ / ctx").
 *
 * P1 surface — deliberately narrow:
 * - on / registerCommand / registerTool (opencc extensions over upstream)
 * - ui.notice (mod → host one-way push) and ui.log
 *
 * P2 (not here, per doc §3.3): ui.ask / ui.toast / prompt.compose / prompt.read
 * / turn.abort / ctx.fs (authorization-gated).
 *
 * ── zai patch (2026-10-06):TUI 能力面已移除 ────────────────────────────
 *
 * opencc 侧本文件另有两块**纯终端 UI** 机制,zai 侧整体删除:
 *
 *  1. `ui.pane` / `ui.closePane` / `ui.notify`（P3 render site）+ 下方的
 *     pane 注册表（`modPanes` / `getModPanesSnapshot` / `subscribeModPanes` /
 *     `notifyPaneChanged` / `clearModPanes`）。它们的唯一消费者是 ink 组件
 *     `ModPaneArea` + `ModStatusLine`（opencc `src/components/`）—— zai 的
 *     UI 是 Web UI,这些 React/Ink 渲染路径永不执行。
 *  2. `ui.render` 事件（`MOD_RENDER_EVENT`,opencc 09:05 commit `1d1f3272`
 *     新增）。它在 React render 期间跑同步字符串变换,消费方是
 *     `PromptInput` 的渲染管线。实测 `runModRenderChainSync` /
 *     `hasModRenderHandlers` 在 vendor 里**零调用方**。
 *
 * 保留的是 `ui.notice` 与 `ui.status`:它们是 **mod → 宿主的单向数据推送**,
 * 不绑定任何渲染技术。zai 侧把 notice 桥到 Web UI 的通知队列
 * （见 bundle-entry 导出的 `subscribeModNotices`）,status 保留给未来的
 * 状态栏/侧栏消费。判据是「数据 vs 渲染」,不是「有用没用」。
 *
 * 若将来 zai 要做 mod 面板,应在 **Web UI 侧**新建组件 + 订阅
 * `subscribeModNotices` 那类通道,而不是把 Ink 的 pane 机制搬回来。
 */

const MOD_SPEC_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/
const MOD_NOTICE_MAX_CHARS = 2000

/**
 * Upstream teaches the call shape in its own refusal message; matching that
 * beats listing 109 names nobody reads. The prefixes are enough to tell a
 * dotted name from a classic hook name at a glance.
 */
const EVENT_PREFIXES = [...new Set(MOD_EVENTS.map(e => e.split('.')[0]!))]
const SUPPORTED_EVENTS_HINT =
  `on is always on("<event>", hook), where <event> is one of upstream's ` +
  `${MOD_EVENTS.length} dotted names (${EVENT_PREFIXES.join(' / ')}.*) — ` +
  `not a settings.json hook name like PreToolUse, which is tool.call here`

// ── zai patch (2026-10-06):上游此处的 Pane 注册表( `PanePlacement` /
// `ModPaneSpec` / `setModPane` / `getModPanesFor` / `closeModPane` /
// `notifyPaneChanged` / `clearModPanes` / `setPaneCloseListener` —— `$.ui.open`
// / `close` / `panes` 的宿主侧)整体删除:唯一消费方是 ink 组件 ModPaneArea,
// zai 的 UI 是 Web UI,永不执行。详见文件头的能力面说明。

export type ModNotice = {
  key: string
  modName: string
  text: string
}


// ── zai patch (2026-10-06):此处原本是 ui.pane 注册表（modPanes /
// getModPanesSnapshot / subscribeModPanes / notifyPaneChanged /
// clearModPanes / __resetModPanesForTesting），随 TUI 能力面一并删除。
// 理由见文件头的能力面说明。

/** Fenced filesystem API (P2 授权制, docs/mods-plan.md §3.3). */
export type ModFsApi = {
  read(path: string): Promise<string>
  write(path: string, data: string): Promise<void>
  list(path: string): Promise<string[]>
  exists(path: string): Promise<boolean>
  /**
   * Upstream `$.fs.stat` — size and directory-ness of one path, or undefined
   * when it is not there.
   */
  stat(path: string): Promise<{ size: number; isDirectory: boolean } | undefined>
  /**
   * Upstream `$.fs.ancestors({names, of?, below?})` — walk from `of` (default
   * the session cwd) up one directory at a time, reading the first matching
   * name in each, stopping after `below`.
   *
   * This is what makes instruction-file ancestry expressible: a mod resolves
   * "every AGENTS.md between the project root and this file" with one call,
   * the same way upstream's own AGENTS.md plugin does.
   */
  ancestors(args: ModAncestorsArgs): Promise<FsAncestor[]>
}

/** A dotted event name. The settings.json hook names are not accepted. */
export type ModEventRef = ModEventName

export type ModContext = {
  /**
   * A streaming event: `async function* ($, e, next)`, where `next(e)` is
   * the stream beneath rather than a promise.
   *
   * Declared ahead of the generic overload on purpose: the handler's shape
   * differs, and the generic one would claim it and mis-type every streaming
   * hook.
   */
  on(event: ModStreamEvent, handler: ModStreamHandler): void
  on(event: ModEventRef, handler: ModHandlerInput): void
  /**
   * Upstream's matcher shape: a plain object nested against the event, with
   * four leaf kinds (exact, RegExp, any-of, partial). `{ to: 'core' }` is
   * lifted out as the tier rather than matched as an event field.
   */
  on(event: ModEventRef, matcher: ModMatcher, handler: ModHandlerInput): void
  // zai patch (2026-10-06):上游在通用重载之前还有一条 `ui.render` 的同步
  // 重载 —— 它跑在 React render 期间,消费方是 PromptInput,Web UI 无此路径,
  // 故随 TUI 能力面删除。`ui.render` 也不在 `isModEventName` 的表里,传进来
  // 会走下面的 "unsupported event" 分支。
  registerCommand(spec: ModCommandSpec): void
  registerTool(spec: ModToolSpec): void
  ui: {
    /** One-way push to the host UI (toast/notification slot). */
    notice(text: string): void
    /** Debug-log a line attributed to this mod. */
    log(text: string): void
    /** Persistent status segment (P2); empty string clears. */
    status(text: string): void
    /**
     * Upstream `$.ui.toast` @3831736. Same channel as `notice`: the notice
     * bus carries no lifetime, so `timeoutMs` is accepted and ignored rather
     * than silently dropped from the signature.
     */
    toast(text: string, options?: { timeoutMs?: number }): void
    // zai patch (2026-10-06):`ui.open` / `close` / `panes` / `resolve` /
    // `scroll` / `focus` / `selection` / `copy` / `blit` / `invalidate` /
    // `pane` / `closePane` / `notify` 已删(全部绑定终端渲染或终端设备)。
    // mod 若调用它们会得到 "not a function" —— 这是有意的:让依赖 TUI 渲染的
    // mod 尽早暴露,而不是静默无效。
  }
  /**
   * Fenced filesystem access. Present ONLY when the mod is authorized
   * (P2 授权制) — zai 的取舍,**刻意与上游不同**。
   *
   * 上游已移除 `settings.mods.authorized` 白名单,判据是「路径围栏而非身份」
   * (契约 §二:边界是路径,没有 allowlist,靠发布前的 `claude plugin validate`
   * 静态校验兜底)。zai 没有 validate 环节,直接照搬等于对任意 mod 开放宿主
   * 文件系统读 —— 故保留授权门。详见文件头。
   */
  fs?: ModFsApi
  /** Cross-mod key/value state, session-scoped. Upstream `$.store`. */
  store: ModStore
  /** This mod's own key/value state, namespaced by mod name. Upstream `$.state`. */
  state: ModState
  /** Timers. Upstream `$.clock` — note `after`/`every` are fire-and-forget. */
  clock: ModClock
  /** Environment reads and writes. Upstream `$.env`. */
  env: ModEnv
  /** Subprocess execution. Upstream `$.process`. */
  process: ModProcess
  /** What the mod is running inside. Upstream `$.session`. */
  session: ModSession
  /** Usage rows. Upstream `$.telemetry`. */
  telemetry: ModTelemetry
  /** Host settings. Upstream `$.settings`. */
  settings: ModSettings
  /** Feature flag values. Upstream `$.flag`. */
  flag: ModFlag
  /** Outbound HTTP. Upstream `$.http`. */
  http: ModHttp
  /** Tool inventory. Upstream `$.tool`. */
  tool: ModTool
  /** Slash command inventory and dispatch. Upstream `$.command`. */
  command: ModCommand
  /** Subagent inventory. Upstream `$.agent`. */
  agent: ModAgent
  /** One-shot completions through the session's own client. Upstream `$.model`. */
  model: ModModel
  /** Settings read/write. Upstream `$.config`. */
  config: ModConfig
  /** The prompt box as it stands. Upstream `$.prompt`. */
  prompt: ModPrompt
  /**
   * The mod's saved `userConfig` values — declared in `opencc-mod.json`,
   * edited via `/plugins` → Installed → Configure options.
   *
   * Always an object: empty when the mod declares no options or the user
   * saved none. Schema `default`s are deliberately NOT applied here, because
   * "the user chose the default" and "the user never touched this" are
   * different states and only the mod knows whether the difference matters.
   */
  options: PluginOptionValues
  /**
   * Upstream `$.plugin` (d.ts:2325) — "This plugin, as loaded: its manifest
   * name and its directory". The first noun every mod's own lifecycle reads:
   * a framework opens its `startMod($)` with `$.plugin.name` and dies without
   * it, and it is the only member of upstream's 21-noun `$` that costs nothing
   * to answer — the loader already resolved both.
   */
  plugin: {
    name: string
    /** The mod's directory, absolute. */
    root: string
  }
}

// ---------------------------------------------------------------------------
// ui.notice channel — REPL subscribes and maps to addNotification (the host's
// existing notification queue). Bridge keeps mods decoupled from React state.
// ---------------------------------------------------------------------------

const noticeListeners = new Set<(notice: ModNotice) => void>()
let noticeSeq = 0

export function subscribeModNotices(
  listener: (notice: ModNotice) => void,
): () => void {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

function emitModNotice(modName: string, text: string): void {
  const trimmed =
    text.length > MOD_NOTICE_MAX_CHARS
      ? `${text.slice(0, MOD_NOTICE_MAX_CHARS)}…`
      : text
  const notice: ModNotice = {
    key: `mod-notice-${modName}-${noticeSeq++}`,
    modName,
    text: trimmed,
  }
  for (const listener of noticeListeners) {
    try {
      listener(notice)
    } catch (error) {
      logForDebugging(
        `[mods] notice listener error: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

// Streamed handler progress (P2 流式事件) rides the same notice channel.
subscribeModProgress((modName, text) => emitModNotice(modName, text))

/** Host-side system notice attributed to the mods runtime itself. */
export function emitModsSystemNotice(text: string): void {
  emitModNotice('system', text)
}

// ---------------------------------------------------------------------------
// ui.status slot (P2 pane/status): persistent per-mod status segments, rendered
// by the REPL above the prompt input. Snapshot is reference-stable between
// changes for useSyncExternalStore.
// ---------------------------------------------------------------------------

const modStatuses = new Map<string, string>()
const statusListeners = new Set<() => void>()
let statusSnapshot: Record<string, string> = {}
let statusVersion = 0

export function getModStatusSnapshot(): Record<string, string> {
  return statusSnapshot
}

export function subscribeModStatus(listener: () => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

export function getModStatusVersion(): number {
  return statusVersion
}

function setModStatus(modName: string, text: string | undefined): void {
  if (text === undefined || text === '') {
    if (!modStatuses.has(modName)) return
    modStatuses.delete(modName)
  } else {
    const next = text.slice(0, MOD_NOTICE_MAX_CHARS)
    if (modStatuses.get(modName) === next) return
    modStatuses.set(modName, next)
  }
  statusSnapshot = Object.fromEntries(modStatuses)
  statusVersion++
  for (const listener of statusListeners) listener()
}

/** Clear a mod's persistent status segment (unload path — gh status residue). */
export function clearModStatus(modName: string): void {
  setModStatus(modName, undefined)
}

// ---------------------------------------------------------------------------
// ctx.fs — fenced filesystem API.
//
// Upstream hands every plugin `$.fs` unconditionally and bounds it by path, not
// by identity: a path resolves against the working directory or is absolute, a
// file the plugin ships is under `$.plugin.root`, and one read is capped
// (`d.ts:2738-2751`). There is no allowlist to be listed in — so the gate that
// used to live here was opencc's own, and it had two costs that outweighed the
// one it bought: an authorized mod is indistinguishable from an unauthorized one
// in the source, so a port of an official mod (`agents-md` calls
// `$.fs.ancestors()`) either has to be patched or throws a TypeError on
// `undefined`, and the failure surfaces in the mod, not in the plugin that
// silently withheld a documented API.
//
// The bound is the fence: realpath on both the roots and the target, then a
// `relative()` containment check on every call. A symlink out of the roots
// resolves before the comparison, so it does not pass.
// ---------------------------------------------------------------------------

/** Upstream's per-read cap — `d.ts:2745`. */
const MAX_FS_READ_BYTES = 4 * 1024 * 1024

async function buildFsApi(
  modName: string,
  allowedRoots: string[],
): Promise<ModFsApi> {
  const rootReals = await Promise.all(
    allowedRoots.map(root => realpath(root).catch(() => root)),
  )
  const assertFenced = async (path: string): Promise<string> => {
    const abs = resolve(path)
    let real: string
    try {
      real = await realpath(abs)
    } catch (error) {
      throw new Error(
        `[mods:${modName}] fs path not found: ${path}`,
        { cause: error },
      )
    }
    const inside = rootReals.some(
      root => !relative(root, real).startsWith('..'),
    )
    if (!inside) {
      throw new Error(
        `[mods:${modName}] fs path escapes authorized roots: ${path}`,
      )
    }
    return real
  }
  /**
   * Fence `path` when it already exists. Returns null when it is absent, so a
   * file that is about to be created only needs its parent fenced.
   */
  const assertFencedIfExists = async (path: string): Promise<string | null> => {
    try {
      return await assertFenced(path)
    } catch (error) {
      if (
        (error as { cause?: NodeJS.ErrnoException }).cause?.code === 'ENOENT'
      ) {
        return null
      }
      throw error
    }
  }
  return {
    async read(path) {
      return dispatchModOp('fs.read', { path }, async () => {
        const abs = await assertFenced(path)
        // Upstream d.ts:2745 — "Rejects when missing, or over 4 MiB, which
        // bounds what one read copies into the plugin's environment."
        const { size } = await stat(abs)
        if (size > MAX_FS_READ_BYTES) {
          throw new Error(
            `[mods:${modName}] fs.read: ${path} is ${size} bytes, over the ` +
              `${MAX_FS_READ_BYTES} byte limit`,
          )
        }
        return readFile(abs, 'utf8')
      })
    },
    async write(path, data) {
      return dispatchModOp('fs.write', { path, data }, async () => {
      const abs = resolve(path)
      // The file itself may not exist yet — fence on its parent directory.
      const parentReal = await assertFenced(resolve(abs, '..'))
      const fileName = abs.slice(abs.lastIndexOf('/') + 1)
      const target = resolve(parentReal, fileName)
      // Fence the final path too when it exists. writeFile follows a symlink
      // sitting at the last segment, so parent-only fencing let a mod write
      // through `link.txt -> /outside/secret.txt` and land outside the roots.
      // read/list/exists already fence the final path; write was the odd one
      // out, breaking the "containment check on every call" promise above.
      await assertFencedIfExists(target)
      await writeFile(target, data, 'utf8')
      })
    },
    async list(path) {
      return dispatchModOp('fs.list', { path }, async () =>
        readdir(await assertFenced(path)),
      )
    },
    async exists(path) {
      return dispatchModOp('fs.exists', { path }, async () => {
        try {
          await assertFenced(path)
          return true
        } catch {
          return false
        }
      })
    },
    async stat(path) {
      return dispatchModOp('fs.stat', { path }, async () => {
        const real = await assertFencedIfExists(path)
        if (real === null) return undefined
        const info = await stat(real)
        return { size: info.size, isDirectory: info.isDirectory() }
      })
    },
    /**
     * Upstream `$.fs.ancestors` — the walk upstream's own AGENTS.md plugin is
     * built on, so it has to climb directories rather than touch one file.
     *
     * `below` is an *inclusive* bound: the directory itself is checked and the
     * walk stops there. Upstream's plugin asks for `{below: root}` and then
     * drops the root-level hits itself with its own "is below" test, so
     * excluding it here would mean the plugin silently missed a file it
     * expects to filter.
     *
     * A candidate outside the authorized roots is *skipped*, not an error. A
     * walk is a "collect what you can see" query — refusing the whole call
     * because one ancestor is out of bounds would make the common case (cwd
     * inside the project, root above it) unusable, and fencing each hit as it
     * is found is what stops a walk from reading outward one level at a time.
     */
    async ancestors(args: ModAncestorsArgs) {
      return dispatchModOp('fs.ancestors', args, async () => {
        const names = args.names ?? []
        if (names.length === 0) return []
        const start = resolve(args.of ?? process.cwd())
        const stop = args.below ? resolve(args.below) : undefined
        if (stop !== undefined) {
          const rel = relative(stop, start)
          // A `below` that is not an ancestor of `of` would otherwise walk all
          // the way to `/`, handing over the whole filesystem in one call.
          if (rel.startsWith('..') || isAbsolute(rel)) return []
        }
        const found: FsAncestor[] = []
        let dir = start
        for (;;) {
          for (const name of names) {
            try {
              const real = await assertFencedIfExists(join(dir, name))
              if (real === null) continue
              found.push({
                dir,
                parts: [{ path: real, content: await readFile(real, 'utf8') }],
              })
            } catch {
              // Out of the authorized roots, or unreadable — skip this
              // candidate and try the next name in this directory.
              continue
            }
            break
          }
          if (stop !== undefined && dir === stop) break
          const parent = dirname(dir)
          if (parent === dir) break
          dir = parent
        }
        return found
      })
    },
  }
}

/** Lazy variant: ctx construction stays synchronous; roots resolve on first call. */
function buildFsApiLazy(modName: string, allowedRoots: string[]): ModFsApi {
  let apiPromise: Promise<ModFsApi> | undefined
  const get = () => (apiPromise ??= buildFsApi(modName, allowedRoots))
  return {
    read: path => get().then(api => api.read(path)),
    write: (path, data) => get().then(api => api.write(path, data)),
    list: path => get().then(api => api.list(path)),
    exists: path => get().then(api => api.exists(path)),
    stat: path => get().then(api => api.stat(path)),
    ancestors: args => get().then(api => api.ancestors(args)),
  }
}

// ---------------------------------------------------------------------------
// ctx.fs authorization gate (P2 授权制) — zai patch, deliberately divergent
// from upstream.
//
// Upstream REMOVED the `settings.mods.authorized` allowlist: its bound is the
// path fence, not identity (contract §二 — "边界是路径…没有 allowlist"), and it
// leans on `claude plugin validate` at publish time to audit which vars/files a
// mod touches. zai has no validate step, so copying the removal verbatim would
// hand every loaded mod an unrestricted read of the host filesystem. The fence
// stays; authorization on top of it stays too.
//
// If zai ever grows a mod-publishing validation step, this is the place to
// revisit — it must be one decision, not two.
// ---------------------------------------------------------------------------

function isModFsAuthorized(modName: string): boolean {
  if (fsAuthOverrideForTesting) return fsAuthOverrideForTesting(modName)
  const authorized = getSettings_DEPRECATED()?.mods?.authorized
  logForDebugging(
    `[mods] fs auth check "${modName}": authorized=${JSON.stringify(authorized)}`,
  )
  return Array.isArray(authorized) && authorized.includes(modName)
}

let fsAuthOverrideForTesting: ((modName: string) => boolean) | undefined

/** For tests only — bypass settings lookup. */
export function setModFsAuthOverrideForTesting(
  fn?: (modName: string) => boolean,
): void {
  fsAuthOverrideForTesting = fn
}

/**
 * The mod's saved `userConfig` values. Never throws: a settings read failure
 * must not take the whole mod down, and a mod that declared options but never
 * saved them simply sees `{}`.
 */
function readModOptions(mod: LoadedMod): PluginOptionValues {
  try {
    const builtin = mod.root === BUILTIN_ORIGIN
    return loadPluginOptions(modPluginId(mod.manifest.name, builtin))
  } catch (error) {
    logForDebugging(
      `[mods] failed to read options for "${mod.manifest.name}": ${errorMessage(error)}`,
    )
    return {}
  }
}

// ---------------------------------------------------------------------------
// ctx construction
// ---------------------------------------------------------------------------

/**
 * Put the engine back in front of a handler that expects to find it there.
 *
 * Upstream's hook is `($: EngineInterface, e, next)` — three parameters, `$`
 * FIRST. `MatchedHook` at d.ts:5758 says so, and published mods are written to
 * it: a framework's own lifecycle opens `startMod($, eventInput, passOn)` and
 * builds its whole surface from `$.plugin`, `$.session`, `$.fs`. Called as
 * `handler(e, next)` that `$` is the event, `$.plugin` is undefined, and the
 * mod's lifecycle never starts — the handler throws, the dispatch layer
 * attributes it and moves on, and the mod looks installed and inert.
 *
 * Arity, not a flag: a handler that declares three parameters is asking for
 * the engine, and one that declares two is the older `(e, next)` shape that
 * opencc's own built-ins and mods are written in. Both run; neither is rewritten
 * at the call site.
 */
function withEngineInterface(
  ctx: ModContext,
  handler: ModHandlerInput,
): ModHandler {
  if (handler.length < 3) return handler as ModHandler
  const wantsEngine = handler as unknown as (
    $: ModContext,
    e: Record<string, unknown>,
    next: ModNext,
  ) => unknown
  return ((e: Record<string, unknown>, next: ModNext) =>
    wantsEngine(ctx, e, next)) as ModHandler
}

export function createModContext(mod: LoadedMod): ModContext {
  const modName = mod.manifest.name
  const nouns = buildModNouns(modName)
  // zai patch: fs 授权门保留(见 ModContext['fs'] 的说明)。上游这里是
  // 无条件构造(`Present for every mod`),因为上游把白名单删了。
  // P2 授权制: presence is decided at register() time (deterministic for
  // mod authors).
  const fsApi: ModFsApi | undefined = isModFsAuthorized(modName)
    ? buildFsApiLazy(modName, [process.cwd(), mod.root])
    : undefined
  const ctx: ModContext = {
    options: readModOptions(mod),
    plugin: { name: modName, root: mod.root },
    // Every method below dispatches its own event, so a noun being present is
    // the same fact as its op events being live (docs/mods-upstream-contract.md
    // §1.2). Nothing here is a name without a call behind it.
    store: nouns.store,
    state: nouns.state,
    clock: nouns.clock,
    env: nouns.env,
    process: nouns.process,
    session: nouns.session,
    telemetry: nouns.telemetry,
    settings: nouns.settings,
    flag: nouns.flag,
    http: nouns.http,
    tool: nouns.tool,
    command: nouns.command,
    agent: nouns.agent,
    model: nouns.model,
    config: nouns.config,
    prompt: nouns.prompt,
    on(event, matcherOrHandler, maybeHandler?) {
      if (typeof event !== 'string' || !isModEventName(event)) {
        throw new Error(
          `ctx.on(): unsupported event "${String(event)}". Supported: ${SUPPORTED_EVENTS_HINT}`,
        )
      }
      const canonical = event as ModEventName
      const unavailable = unavailabilityReason(canonical)
      if (unavailable !== undefined) {
        throw new Error(`ctx.on("${canonical}"): ${unavailable}`)
      }
      // zai patch (2026-10-06):上游此处有一条 `ui.render` 分支(同步字符串
      // 变换,跑在 React render 里,消费方是 PromptInput,Web UI 无此路径)。
      // 它已随 TUI 能力面删除;`ui.render` 不在 `MOD_EVENTS` 里,传进来会走
      // 上面的 unsupported-event 拒绝分支,给出明确的错误。
      const hasExplicitMatcher =
        matcherOrHandler !== null &&
        typeof matcherOrHandler === 'object' &&
        typeof maybeHandler === 'function'
      if (!hasExplicitMatcher && typeof maybeHandler === 'function') {
        throw new Error('ctx.on(): too many arguments')
      }
      const handler = (
        hasExplicitMatcher ? maybeHandler : matcherOrHandler
      ) as ModHandlerInput | undefined
      if (typeof handler !== 'function') {
        throw new Error('ctx.on(): handler must be a function')
      }
      const { matcher, tier } = hasExplicitMatcher
        ? splitTier(matcherOrHandler as ModMatcher)
        : { matcher: undefined, tier: undefined }
      mod.handlers.push({
        event: canonical,
        matcher,
        tier,
        handler: withEngineInterface(ctx, handler),
      })
    },
    registerCommand(spec) {
      return dispatchModOpSync('command.register', { spec }, () => {
      if (!spec || typeof spec !== 'object') {
        throw new Error('ctx.registerCommand(): spec object required')
      }
      if (
        typeof spec.name !== 'string' ||
        !MOD_SPEC_NAME_PATTERN.test(spec.name)
      ) {
        throw new Error(
          `ctx.registerCommand(): name must match [a-zA-Z0-9_-]{1,40}, got "${String(spec?.name)}"`,
        )
      }
      if (typeof spec.handler !== 'function' && typeof spec.call !== 'function') {
        throw new Error(
          'ctx.registerCommand(): provide handler (type "local") or call (type "local-jsx")',
        )
      }
      if (typeof spec.handler === 'function' && typeof spec.call === 'function') {
        throw new Error(
          'ctx.registerCommand(): handler and call are mutually exclusive',
        )
      }
      mod.commands.push(spec)
      })
    },
    registerTool(spec) {
      return dispatchModOpSync('tool.register', { spec }, () => {
      if (!spec || typeof spec !== 'object') {
        throw new Error('ctx.registerTool(): spec object required')
      }
      if (
        typeof spec.name !== 'string' ||
        !MOD_SPEC_NAME_PATTERN.test(spec.name)
      ) {
        throw new Error(
          `ctx.registerTool(): name must match [a-zA-Z0-9_-]{1,40}, got "${String(spec?.name)}"`,
        )
      }
      if (typeof spec.execute !== 'function') {
        throw new Error('ctx.registerTool(): execute must be a function')
      }
      if (
        !spec.inputSchema ||
        typeof spec.inputSchema !== 'object' ||
        (spec.inputSchema as { type?: unknown }).type !== 'object'
      ) {
        throw new Error(
          'ctx.registerTool(): inputSchema must be a JSON Schema object with type:"object"',
        )
      }
      mod.tools.push(spec)
      })
    },
    ui: {
      notice(text: string) {
        return dispatchModOpSync('ui.notice', { text }, () => {
          if (typeof text !== 'string' || text.trim() === '') return
          emitModNotice(modName, text)
        })
      },
      /**
       * Upstream `$.ui.toast` @3831736.
       *
       * Same channel as `notice` today: the notice bus carries no lifetime,
       * so `timeoutMs` is accepted and ignored rather than silently dropped
       * from the signature. Giving the bus a timeout means changing the host
       * notification queue, which reaches past this surface.
       */
      toast(text: string, options?: { timeoutMs?: number }) {
        return dispatchModOpSync('ui.toast', { text, options }, () => {
          if (typeof text !== 'string' || text.trim() === '') return
          if (options?.timeoutMs !== undefined) {
            logForDebugging(
              `[mods:${modName}] ui.toast: timeoutMs is not honoured by this host; the toast will persist until dismissed`,
            )
          }
          emitModNotice(modName, text)
        })
      },
      log(text: string) {
        return dispatchModOpSync('ui.log', { text }, () => {
          logForDebugging(`[mods:${modName}] ${String(text)}`)
        })
      },
      status(text: string) {
        return dispatchModOpSync('ui.status', { text }, () => {
          if (typeof text !== 'string') return
          setModStatus(modName, text.trim() === '' ? undefined : text)
        })
      },
      // zai patch (2026-10-06):`ui.open` / `close` / `panes` / `resolve` /
      // `scroll` / `focus` / `selection` / `copy` / `blit` / `invalidate` /
      // `pane` / `closePane` / `notify` 已随 TUI 能力面删除(opencc 侧由 ink
      // 组件 ModPaneArea / ModStatusLine 消费,zai 永不执行)。保留的是
      // `notice` / `toast` / `status` —— 它们是 **mod → 宿主的单向数据推送**,
      // 不绑定任何渲染技术。
    },
    ...(fsApi ? { fs: fsApi } : {}),
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Mod tools — MCPTool-shaped dynamic tools (docs/mods-plan.md §2.1: 照抄
// MCPTool 形状). Names are prefixed `mods_<mod>_<tool>` so a mod can never
// shadow a built-in (assembleToolPool dedupes by name with built-ins winning).
// ---------------------------------------------------------------------------

function createModTool(mod: LoadedMod, spec: ModToolSpec): Tool {
  const toolName = `mods_${mod.manifest.name}_${spec.name}`
  return {
    ...MCPTool,
    name: toolName,
    isMcp: true,
    mcpInfo: { serverName: `mod:${mod.manifest.name}`, toolName: spec.name },
    async description() {
      return spec.description
    },
    async prompt() {
      return spec.description
    },
    inputJSONSchema: spec.inputSchema as Tool['inputJSONSchema'],
    async checkPermissions() {
      return {
        behavior: 'passthrough' as const,
        message: `Mod tool ${toolName} requires permission.`,
      }
    },
    async call(args: Record<string, unknown>) {
      const output = await spec.execute(args)
      return {
        data:
          typeof output === 'string' ? output : JSON.stringify(output, null, 2),
      }
    },
  } as Tool
}

let modToolsCache: Tool[] | null = null
let modToolsCacheVersion = -1
/** 记录每个工具属于哪个 mod —— per-session 门禁要按 mod 过滤,不能只靠解析前缀。 */
let modToolOwner = new Map<string, string>()

/**
 * Tools contributed by all loaded mods (version-keyed cache).
 *
 * zai patch (2026-10-06):传 `sessionId` 时按该会话的 mod 门禁过滤
 * (mainAgent `mods` 槽)。省略时行为与 opencc 完全一致(全部可见)。
 */
export function getModTools(sessionId?: string): Tool[] {
  const version = getModToolsVersion()
  if (modToolsCache && modToolsCacheVersion === version) {
    return filterBySession(modToolsCache, sessionId)
  }
  const tools: Tool[] = []
  const owners = new Map<string, string>()
  for (const mod of getLoadedMods()) {
    for (const spec of mod.tools) {
      try {
        const tool = createModTool(mod, spec)
        tools.push(tool)
        owners.set(tool.name, mod.manifest.name)
      } catch (error) {
        logForDebugging(
          `[mods] failed to build tool ${mod.manifest.name}:${spec.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  modToolsCache = tools
  modToolsCacheVersion = version
  modToolOwner = owners
  return filterBySession(tools, sessionId)
}

/** zai patch (2026-10-06):按会话门禁过滤工具;无门禁时原样返回(零分配)。 */
function filterBySession(tools: Tool[], sessionId?: string): Tool[] {
  if (!hasSessionModGate(sessionId)) return tools
  return tools.filter(t => {
    const owner = modToolOwner.get(t.name)
    // 认不出归属的工具(理论上不该有)保守保留 —— 门禁是可见性控制,
    // 宁可多给一个也不要把宿主工具误删。
    return owner === undefined || isModVisibleForSession(owner, sessionId)
  })
}

// ---------------------------------------------------------------------------
// Mod commands — LocalCommand-shaped (docs/mods-plan.md §2.1: registerCommand
// 现成通道). Disk mod commands are namespaced `<modName>:<name>` (plugin
// convention, cannot shadow built-ins). Built-in mods are first-party and
// register top-level commands (upstream cc-plugin-diff parity: /diff is a
// top-level command) — the caller (appendModCommands) dedupes against
// existing names so a built-in can never shadow a host command.
//
// Two shapes: `handler` → LocalCommand (text to the user), `call` →
// LocalJSXCommand (the mod renders the interaction and decides, via onDone,
// what enters the conversation — handoff uses it to render its document
// picker without a model AskUserQuestion round-trip).
// ---------------------------------------------------------------------------

export function buildModCommands(sessionId?: string): Command[] {
  const commands: Command[] = []
  for (const mod of getLoadedMods()) {
    // zai patch (2026-10-06):per-session mod 门禁(mainAgent `mods` 槽)。
    // 无门禁时 isModVisibleForSession 恒 true,行为与 opencc 一致。
    if (!isModVisibleForSession(mod.manifest.name, sessionId)) continue
    const isBuiltin = mod.root === BUILTIN_ORIGIN
    for (const spec of mod.commands) {
      const runtimeName = isBuiltin
        ? spec.name
        : `${mod.manifest.name}:${spec.name}`
      const base = {
        name: runtimeName,
        description:
          spec.description ?? `Command provided by mod "${mod.manifest.name}"`,
        ...(spec.argumentHint ? { argumentHint: spec.argumentHint } : {}),
        ...(spec.immediate ? { immediate: true } : {}),
      }
      if (typeof spec.call === 'function') {
        // local-jsx: the mod owns the whole interaction — it renders the
        // component and calls onDone to say what enters the conversation.
        // Used by the handoff mod so document selection is program-rendered
        // instead of routed through a model AskUserQuestion call.
        commands.push({
          ...base,
          type: 'local-jsx',
          ...(spec.supportsNonInteractive
            ? { supportsNonInteractive: true }
            : {}),
          load: async () => ({ call: spec.call! }),
        })
        continue
      }
      const handler = spec.handler!
      commands.push({
        ...base,
        type: 'local',
        supportsNonInteractive: true,
        load: async () => ({
          call: async (args: string) => {
            const output = await handler(args)
            return {
              type: 'text' as const,
              value:
                typeof output === 'string'
                  ? output
                  : JSON.stringify(output, null, 2),
            }
          },
        }),
      })
    }
  }
  return commands
}
