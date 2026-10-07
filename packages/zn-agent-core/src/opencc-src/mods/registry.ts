import type { HookEvent } from '../types/hooks.js'
import type { LocalJSXCommandCall } from '../types/command.js'
import type { ModManifest } from './manifest.js'

/**
 * Mod registry — lifecycle state for loaded mods (docs/mods-plan.md §3.4).
 *
 * This module owns the shared types (specs + LoadedMod) so that engine.ts and
 * dispatch.ts can both import from here without import cycles. It holds no
 * behavior beyond registration bookkeeping and change notification for the
 * tool pool (REPL re-renders mod tools via a version counter).
 */

/** Signature of a mod event handler (docs/mods-plan.md §3.3). */
export type ModHandler = (
  e: Record<string, unknown>,
  next: (e?: Record<string, unknown>) => Promise<Record<string, unknown>>,
) => unknown | Promise<unknown>

/**
 * zai patch (2026-10-06):opencc 原本在此定义 `MOD_RENDER_EVENT`('ui.render')
 * / `ModRenderEvent` / `ModRenderHandler` —— 一个跑在 React render 期间的
 * 同步文本变换事件(消费方是 opencc 的 PromptInput)。zai 的 UI 是 Web UI,
 * 不存在这条渲染路径,故整块删除。详见 engine.ts 文件头的能力面说明。
 *
 * 后果:`ctx.on('ui.render', h)` 会走 `isModSupportedEvent` 的查表并被拒,
 * 报 "unsupported event"。这是有意的 fail-fast —— 依赖 TUI 渲染的 mod
 * 应当尽早暴露,而不是静默无效。
 */
export type ModEventName = HookEvent

export type ModHandlerSpec = {
  event: ModEventName
  /** Normalized string matcher (object matchers are converted by dispatch). */
  matcher?: string
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

/** Marker for in-memory built-in mods (src/mods/builtin.ts). */
export const BUILTIN_ORIGIN = '(builtin)'

export function registerLoadedMod(mod: LoadedMod): void {
  loadedMods.push(mod)
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
  notifyModToolsChanged()
  return removed
}

/** Reset registry state. For tests only. */
export function resetModsRegistryForTesting(): void {
  loadedMods = []
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
