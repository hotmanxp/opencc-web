import type { LocalJSXCommandCall } from '../types/command.js'
import type { ModManifest } from './manifest.js'
import type {
  ModEventName,
  ModMatcher,
  ModNext,
  ModTier,
} from './protocol.js'

/**
 * Mod registry — lifecycle state for loaded mods (docs/mods-plan.md §3.4).
 *
 * This module owns the shared types (specs + LoadedMod) so that engine.ts and
 * dispatch.ts can both import from here without import cycles. It holds no
 * behavior beyond registration bookkeeping and change notification for the
 * tool pool (REPL re-renders mod tools via a version counter).
 */

/**
 * Signature of a mod event handler (docs/mods-plan.md §3.3).
 *
 * The return type is `unknown` because a handler on a STREAMING event is an
 * async generator, not a promise: `async function* ($, e, next)` yields the
 * event's chunks and returns its result. `next` is declared to return a
 * promise because that is what the one-shot paths hand it; on the streaming
 * paths it returns the stream beneath instead, and `runModStreamChain` is
 * what actually drives it.
 *
 * Always the TWO-parameter shape, because that is what the dispatch layer
 * invokes. A handler written upstream's way — `($: EngineInterface, e, next)`,
 * `MatchedHook` at d.ts:5758 — is accepted at registration and normalized to
 * this shape by `withEngineInterface`; see `ModHandlerInput`.
 */
export type ModHandler = (
  e: Record<string, unknown>,
  next: ModNext,
) => unknown | Promise<unknown>

/**
 * What `ctx.on()` accepts: opencc's own `(e, next)`, or upstream's
 * `($: EngineInterface, e, next)` with the engine first.
 *
 * Two types rather than one union because the dispatch layer INVOKES a
 * `ModHandler`, and a union that includes the three-parameter form is not
 * callable with two arguments. Keeping the union at the registration boundary
 * lets both be written while everything downstream stays one shape.
 */
export type ModHandlerInput =
  | ModHandler
  | ((
      $: unknown,
      e: Record<string, unknown>,
      next: ModNext,
    ) => unknown | Promise<unknown>)

/**
 * `next` — run the layers beneath — with `next.to` to hand control to a named
 * tier instead of the adjacent one.
 *
 * Upstream `d.ts:5241-5243`: "A managed hook's: prepend may name append,
 * builtin or core, append core; it never skips a tier with more authority",
 * and `d.ts:9642` `TargetTier = Exclude<Tier, 'prepend' | 'user'>` — a hook may
 * only ever descend, never climb. `canDescend` holds the same table.
 */

/**
 * A streaming event's `next` is the STREAM beneath, not a promise.
 *
 * Upstream has exactly two streaming events (`turn.step`, `process.spawn`)
 * and gives them their own `StreamHook` type for this reason: the same
 * `next(e)` call means "await the rest of the chain" on one event and "open
 * a second stream" on the other, and one handler type cannot say both.
 */
export type ModStreamNext = (
  e?: Record<string, unknown>,
) => AsyncGenerator<unknown, unknown>

/**
 * `async function* ($, e, next)`: yields the event's chunks and returns its
 * result. Three shapes are distinguishable — `return yield* next(e)` passes,
 * `for await (c of next(e)) yield f(c)` transforms, yielding without calling
 * `next` answers alone and nothing beneath runs.
 */
export type ModStreamHandler = (
  e: Record<string, unknown>,
  next: ModStreamNext,
) => AsyncGenerator<unknown, unknown>

/** The two events whose handlers are generators rather than functions. */
export type ModStreamEvent = 'turn.step' | 'process.spawn'

/**
 * zai patch (2026-10-06): opencc 原本在此定义 `MOD_RENDER_EVENT`('ui.render')
 * / `ModRenderEvent` / `ModRenderHandler` —— 一个跑在 React render 期间的
 * 同步文本变换事件(消费方是 opencc 的 PromptInput)。zai 的 UI 是 Web UI,
 * 不存在这条渲染路径,故整块删除。详见 engine.ts 文件头的能力面说明。
 *
 * 后果:`ctx.on('ui.render', h)` 会走 `isModSupportedEvent` 的查表并被拒,
 * 报 "unsupported event"。这是有意的 fail-fast —— 依赖 TUI 渲染的 mod
 * 应当尽早暴露,而不是静默无效。
 *
 * 同源删除:`mods/renderTap.ts`(ui.render 的渲染点 tap + LRU 缓存)与
 * `mods/builtin/{diffMod,mermaidMod,handoffMod}`(纯终端 UI 内置 mod)。
 */

/** `ModEventName` / `ModMatcher` / `ModTier` 现由 protocol.ts 定义并在此转出。 */
export type { ModEventName, ModMatcher, ModTier }

export type ModHandlerSpec = {
  event: ModEventName
  /**
   * Structured matcher, evaluated against the frozen event argument by
   * `matchesMatcher`. Upstream also spells the tier here as `to`; the loader
   * lifts it onto `tier` so a matcher can never match on an event field by
   * that name.
   */
  matcher?: ModMatcher
  /** Where in the chain this handler sits. Defaults to `builtin`. */
  tier?: ModTier
  handler: ModHandler
}

export type ModCommandSpec = {
  /** Unprefixed name; the runtime command is `<modName>:<name>`. */
  name: string
  description?: string
  argumentHint?: string
  /**
   * `'local'` (default) renders the handler's return value as text for the
   * user; `'local-jsx'` hands the host a component to render and uses
   * `onDone` to decide what enters the conversation.
   */
  type?: 'local' | 'local-jsx'
  /** Required for `type: 'local'`. */
  handler?: (args: string) => unknown | Promise<unknown>
  /** Required for `type: 'local-jsx'` — same contract as a host local-jsx command. */
  call?: LocalJSXCommandCall
  /** Bypass the input queue (`local-jsx` only, passed through to the host command). */
  immediate?: boolean
  /** Keep the command available in headless sessions (`local-jsx` only). */
  supportsNonInteractive?: boolean
}

export type ModToolSpec = {
  /** Unprefixed name; the runtime tool is `mods_<modName>_<name>`. */
  name: string
  description: string
  /** JSON Schema for the tool input (validated via ajv, MCPTool parity). */
  inputSchema: Record<string, unknown>
  execute: (input: Record<string, unknown>) => unknown | Promise<unknown>
}

export type LoadedMod = {
  manifest: ModManifest
  /** Absolute mod root (as discovered, not realpathed). */
  root: string
  /** Absolute realpathed entry file that was imported. */
  entryPath: string
  handlers: ModHandlerSpec[]
  commands: ModCommandSpec[]
  tools: ModToolSpec[]
}

let loadedMods: LoadedMod[] = []

/**
 * zai patch (2026-10-10, mods 同步):KnownMod 发现层。
 *
 * opencc 把「发现」和「加载」分成两张表:`loadedMods` 装真正在跑的代码,
 * `knownMods` 装被发现过的 mod(含被禁用、因而没有代码在跑的)。
 * 分开的原因是 pluginView 投影 —— 一个被 /plugins 关掉的 mod 故意不进
 * `loadedMods`(代码不该跑),但它仍然需要占一行,否则用户关掉之后就没有
 * 任何控件能再打开它。
 *
 * 注意:本 vendor 的 builtin mods 故意留空(见 builtin.ts),所以实际只会
 * 记录磁盘 mod;`builtin` 字段仍保留以对齐上游形状。
 */
export type KnownMod = {
  builtin: boolean
  userConfig?: Record<string, unknown> | undefined
  /**
   * zai patch (2026-10-10, mods 同步):manifest 里的展示元信息。
   *
   * 为什么必须存在:`getModsAsPlugins()` 优先从**已加载的** mod 取
   * description / version。被禁用的 mod 没有已加载对象(代码不跑),若发现
   * 层不存这两项,用户在 UI 上关掉一个 mod,那一行会当场丢掉版本号和描述
   * —— 看起来像 mod 被抹掉了,而不是被关掉了。这里存的是 manifest 已解析
   * 出来的原值,不需要加载代码。
   */
  description?: string | undefined
  version?: string | undefined
  /**
   * zai patch (2026-10-10, mods 同步):mod 根目录绝对路径。
   *
   * 与 description / version 同理,存它是因为**被禁用的 mod 没有已加载
   * 对象**,而 UI 要用它告诉用户「这个 mod 的文件在哪」—— 用户要停用或删除
   * 一个 mod,得先找得到它。内置 mod 存 `BUILTIN_ORIGIN` 哨兵(没有真实路径)。
   */
  root?: string | undefined
  /**
   * zai patch (2026-10-13, mods 同步第三批):随 bundle 发行但默认关着的
   * 内置 mod。
   *
   * 必须存下来是因为**两个启用态谓词对缺键的默认值相反**:加载器读
   * `=== true`(未打开即关闭),插件列表那一行读 `!== false`(未碰过即启用)。
   * 对功能型 mod 两者一致,对 `optIn` 的不是 —— 而这一行恰恰是唯一能把
   * 它打开的控件,显示成「已启用」就等于把唯一的修复入口标成已修好。
   * 磁盘 mod 恒为 false,只有内置声明能置 true。
   */
  optIn?: boolean | undefined
}

let knownMods = new Map<string, KnownMod>()

export function noteDiscoveredMod(
  name: string,
  builtin: boolean,
  userConfig?: Record<string, unknown>,
  meta?: {
    description?: string
    version?: string
    root?: string
    optIn?: boolean
  },
): void {
  if (knownMods.has(name)) return
  knownMods.set(name, { builtin, userConfig, ...meta })
}

export function getKnownMods(): ReadonlyMap<string, KnownMod> {
  return knownMods
}

/** Forget discovery results. Called per `loadMods()` pass so a deleted mod
 *  folder stops lingering in the plugin list. */
export function clearKnownMods(): void {
  knownMods = new Map()
}

/**
 * Fires whenever the set of loaded mods changes (register or unregister).
 *
 * Consumers that memoize per-mod output subscribe here — the dispatch chains
 * are keyed on the mod set, so a subscriber that does not hear about a
 * register/unregister keeps dispatching against mods that are gone.
 */
const modSetListeners = new Set<() => void>()

export function subscribeModSetChanged(listener: () => void): () => void {
  modSetListeners.add(listener)
  return () => {
    modSetListeners.delete(listener)
  }
}

function notifyModSetChanged(): void {
  for (const listener of modSetListeners) {
    try {
      listener()
    } catch {
      // A broken subscriber must not break registration.
    }
  }
}

/** Marker for in-memory built-in mods (src/mods/builtin.ts). */
export const BUILTIN_ORIGIN = '(builtin)'

export function registerLoadedMod(mod: LoadedMod): void {
  loadedMods.push(mod)
  notifyModSetChanged()
  notifyModToolsChanged()
}

export function getLoadedMods(): readonly LoadedMod[] {
  return loadedMods
}

export function unregisterMod(name: string): LoadedMod | undefined {
  const index = loadedMods.findIndex(m => m.manifest.name === name)
  if (index === -1) return undefined
  const [removed] = loadedMods.splice(index, 1)
  // Drop the circuit-breaker count with the mod (tc-006). Keeping it let a
  // reloaded instance start at N failures and trip the breaker after fewer
  // than MOD_BREAKER_THRESHOLD fresh ones — the count was for code that is no
  // longer loaded.
  failureCounts.delete(name)
  notifyModSetChanged()
  notifyModToolsChanged()
  return removed
}

/** Reset registry state. For tests only. */
export function resetModsRegistryForTesting(): void {
  loadedMods = []
  clearKnownMods()
  // Subscribers hold derived state (the op-event chains), so clearing the set
  // without notifying leaves them dispatching against mods that are gone.
  notifyModSetChanged()
  modToolsVersion++
  notifyModToolsChanged()
  failureCounts.clear()
}

// ---------------------------------------------------------------------------
// Circuit breaker (P2 崩溃归因与熔断): consecutive handler failures per mod.
// At MOD_BREAKER_THRESHOLD consecutive failures the mod is auto-unloaded via
// the listener registered by mods/hooks.ts (avoids a registry→hooks cycle).
// A successful handler invocation resets the count.
// ---------------------------------------------------------------------------

const MOD_BREAKER_THRESHOLD = 5
const failureCounts = new Map<string, number>()
const breakerListeners = new Set<(modName: string, failures: number) => void>()

export function registerModBreakerListener(
  listener: (modName: string, failures: number) => void,
): () => void {
  breakerListeners.add(listener)
  return () => {
    breakerListeners.delete(listener)
  }
}

/** Called by dispatch when a mod handler throws. */
export function recordModHandlerFailure(modName: string): void {
  const count = (failureCounts.get(modName) ?? 0) + 1
  failureCounts.set(modName, count)
  if (count >= MOD_BREAKER_THRESHOLD) {
    failureCounts.set(modName, 0)
    for (const listener of breakerListeners) {
      try {
        listener(modName, count)
      } catch (error) {
        // listener errors must never break the dispatch path
      }
    }
  }
}

/** Called by dispatch after a handler resolves successfully. */
export function recordModHandlerSuccess(modName: string): void {
  failureCounts.delete(modName)
}

export function getModFailureCount(modName: string): number {
  return failureCounts.get(modName) ?? 0
}

// ---------------------------------------------------------------------------
// zai patch (2026-10-06):per-session mod 门禁 —— mainAgent 的 `mods` 槽。
//
// 背景:mainAgent 的前三个槽(systemPrompt / tools / mcp)都是 per-session 的
// (createEngine 按 sid 解析绑定 agent 再派发),而 mod 的注册是**进程级**的 ——
// 之前 mod 一旦加载,其 handler / 工具 / 命令对所有会话可见。这让 mainAgent
// 无法表达"这个身份只要某个 mod 的能力"这类需求,也是上次评估里判定
// "两者不能合并"的核心障碍之一。
//
// 这里补一个显式门禁:agent 的 `mods` 槽给出**该会话启用的 mod 名白名单**,
// 由 host 在三个消费点(工具池 / 命令表 / handler 链)分别过滤。
//
// 语义(与 opencc 原始行为的关系):
//   - 未设置 `mods` 槽 → 全部 mod 可见(= opencc 行为,零回归)
//   - `mods: []`       → 该会话禁用所有 mod
//   - `mods: ['a','b']`→ 只有 a、b 可见
//
// 为什么不做"每个 mod 一个 Worker"式的真隔离:那正是 opencc 自己在 docs
// §3.3 明确分叉掉的方向(同进程 + 熔断)。门禁是**可见性**控制,不是安全
// 边界 —— mod 代码仍然与宿主同进程(见同步文档 §5 M1)。
// ---------------------------------------------------------------------------

/** 未设置 mods 槽时的哨兵:与「显式空数组」区分开。 */
const NO_MOD_GATE = null

/**
 * sessionId → 该会话启用的 mod 名白名单。
 * `null` 值表示"该会话未设门禁"(= 全部可见,与 opencc 一致)。
 * 存 null 而不是 undefined,是为了能显式表达"关闭门禁"。
 */
let sessionModGates: Map<string, Set<string> | null> = new Map()

/**
 * 设置某会话的 mod 白名单。
 *
 * @param modNames 白名单;`null` = 不设门禁(全部 mod 可见)。
 *   传 `[]` 表示禁用所有 mod。
 */
export function setSessionModGate(
  sessionId: string,
  modNames: readonly string[] | null,
): void {
  if (!sessionId) return
  // 复制一份:agent 槽返回的数组可能被复用/后续改写
  sessionModGates.set(
    sessionId,
    modNames === null ? NO_MOD_GATE : new Set(modNames),
  )
}

/** 清掉某会话的门禁(unbind / 删会话时调用,防内存泄漏)。 */
export function clearSessionModGate(sessionId: string): void {
  sessionModGates.delete(sessionId)
}

/** 清掉全部门禁。测试用。 */
export function resetSessionModGatesForTesting(): void {
  sessionModGates = new Map()
}

/** 该会话是否允许某个 mod 生效。未知会话 / 未设门禁 → 允许。 */
export function isModVisibleForSession(
  modName: string,
  sessionId: string | undefined,
): boolean {
  if (!sessionId) return true
  const gate = sessionModGates.get(sessionId)
  // 未设门禁 = opencc 原始行为:全部可见
  if (gate === undefined || gate === null) return true
  return gate.has(modName)
}

/** 该会话的门禁是否生效(用于宿主侧快速跳过整条 mod 链)。 */
export function hasSessionModGate(sessionId: string | undefined): boolean {
  if (!sessionId) return false
  const gate = sessionModGates.get(sessionId)
  return gate !== undefined && gate !== null
}

// ---------------------------------------------------------------------------
// Mod tools change notification — REPL subscribes via useSyncExternalStore so
// tools registered after mount still show up on the next assembleToolPool run
// (useMergedTools useMemo deps include the version).
// ---------------------------------------------------------------------------

let modToolsVersion = 0
const modToolsListeners = new Set<() => void>()

export function getModToolsVersion(): number {
  return modToolsVersion
}

export function subscribeModTools(listener: () => void): () => void {
  modToolsListeners.add(listener)
  return () => {
    modToolsListeners.delete(listener)
  }
}

export function notifyModToolsChanged(): void {
  modToolsVersion++
  for (const listener of modToolsListeners) listener()
}
