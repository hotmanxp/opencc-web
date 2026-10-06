import type { Tool } from '../Tool.js'
import { MCPTool } from '../tools/MCPTool/MCPTool.js'
import type { Command } from '../types/command.js'
import { logForDebugging } from '../utils/debug.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'
import { realpath, readFile, writeFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type {
  LoadedMod,
  ModCommandSpec,
  ModHandler,
  ModToolSpec,
} from './registry.js'
import {
  BUILTIN_ORIGIN,
  getLoadedMods,
  getModToolsVersion,
  hasSessionModGate,
  isModVisibleForSession,
} from './registry.js'
import {
  isModSupportedEvent,
  MOD_SUPPORTED_EVENTS,
  normalizeMatcherValue,
  subscribeModProgress,
  type ModSupportedEvent,
} from './dispatch.js'

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

const SUPPORTED_EVENTS_HINT = MOD_SUPPORTED_EVENTS.join(', ')

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
}

export type ModContext = {
  on(event: ModSupportedEvent, handler: ModHandler): void
  on(
    event: ModSupportedEvent,
    matcher: string | Record<string, unknown>,
    handler: ModHandler,
  ): void
  registerCommand(spec: ModCommandSpec): void
  registerTool(spec: ModToolSpec): void
  ui: {
    /** One-way push to the host UI (toast/notification slot). */
    notice(text: string): void
    /** Debug-log a line attributed to this mod. */
    log(text: string): void
    /** Persistent status segment (P2); empty string clears. */
    status(text: string): void
    // zai patch (2026-10-06):pane / closePane / notify 已删(TUI render
    // site)。ui.render 事件同步删除,故 ModContext['on'] 不再有第三个
    // 重载。理由见文件头。
  }
  /**
   * Fenced filesystem access. Present ONLY when the mod is listed in
   * settings `mods.authorized` — otherwise undefined (P2 授权制: the narrow
   * capability surface stays verifiable by default; authorization is
   * explicit, visible and revocable).
   */
  fs?: ModFsApi
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
// ctx.fs — fenced filesystem API (P2 授权制). Only mods listed in settings
// `mods.authorized` receive the API; allowed roots are the session cwd and
// the mod root. realpath + relative() containment check on every call.
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
  return {
    async read(path) {
      return readFile(await assertFenced(path), 'utf8')
    },
    async write(path, data) {
      const abs = resolve(path)
      // The file itself may not exist yet — fence on its parent directory.
      const parentReal = await assertFenced(resolve(abs, '..'))
      const fileName = abs.slice(abs.lastIndexOf('/') + 1)
      await writeFile(resolve(parentReal, fileName), data, 'utf8')
    },
    async list(path) {
      return readdir(await assertFenced(path))
    },
    async exists(path) {
      try {
        await assertFenced(path)
        return true
      } catch {
        return false
      }
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
  }
}

// ---------------------------------------------------------------------------
// ctx construction
// ---------------------------------------------------------------------------

export function createModContext(mod: LoadedMod): ModContext {
  const modName = mod.manifest.name
  // P2 授权制: fs API only for whitelisted mods; presence is decided at
  // register() time (deterministic for mod authors).
  const fsApi: ModFsApi | undefined = isModFsAuthorized(modName)
    ? buildFsApiLazy(modName, [process.cwd(), mod.root])
    : undefined
  return {
    on(event, matcherOrHandler, maybeHandler?) {
      if (typeof event !== 'string' || !isModSupportedEvent(event)) {
        throw new Error(
          `ctx.on(): unsupported event "${String(event)}". Supported: ${SUPPORTED_EVENTS_HINT}`,
        )
      }
      // zai patch (2026-10-06):opencc 的 `ui.render` 分支已删(同步字符串
      // 变换跑在 React render 里,消费方是 PromptInput,Web UI 不存在这条
      // 路径)。上面 isModSupportedEvent 查 MOD_SUPPORTED_EVENTS(7 个 hook
      // 事件)不含 ui.render,所以传进来会直接被上面那行拒掉,给出明确
      // 的 "unsupported event" 错误。
      const hasExplicitMatcher =
        typeof matcherOrHandler === 'string' ||
        (matcherOrHandler !== null &&
          typeof matcherOrHandler === 'object' &&
          typeof maybeHandler === 'function')
      if (!hasExplicitMatcher && typeof maybeHandler === 'function') {
        throw new Error('ctx.on(): too many arguments')
      }
      const handler = (
        hasExplicitMatcher ? maybeHandler : matcherOrHandler
      ) as ModHandler | undefined
      if (typeof handler !== 'function') {
        throw new Error('ctx.on(): handler must be a function')
      }
      const matcher = hasExplicitMatcher
        ? normalizeMatcherValue(
            event,
            matcherOrHandler as string | Record<string, unknown>,
          )
        : undefined
      mod.handlers.push({ event, matcher, handler })
    },
    registerCommand(spec) {
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
    },
    registerTool(spec) {
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
    },
    ui: {
      notice(text: string) {
        if (typeof text !== 'string' || text.trim() === '') return
        emitModNotice(modName, text)
      },
      log(text: string) {
        logForDebugging(`[mods:${modName}] ${String(text)}`)
      },
      status(text: string) {
        if (typeof text !== 'string') return
        setModStatus(modName, text.trim() === '' ? undefined : text)
      },
      // zai patch (2026-10-06):ui.pane / ui.closePane / ui.notify 已随 TUI
      // 能力面删除(opencc 侧由 ink 组件 ModPaneArea 消费,zai 永不执行)。
      // mod 若调用它们会得到 "not a function" —— 这是有意的:让依赖 TUI
      // 渲染的 mod 尽早暴露,而不是静默无效。
    },
    ...(fsApi ? { fs: fsApi } : {}),
  }
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
