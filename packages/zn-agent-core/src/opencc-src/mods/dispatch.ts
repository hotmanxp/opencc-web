import { logError } from '../utils/log.js'
import { logForDebugging } from '../utils/debug.js'
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  ModChainEntry,
} from '../types/hooks.js'
import type { LoadedMod } from './registry.js'
import {
  getLoadedMods,
  isModVisibleForSession,
  recordModHandlerFailure,
  recordModHandlerSuccess,
} from './registry.js'

/**
 * Mod event dispatch (docs/mods-plan.md §3.3).
 *
 * Tier model (§3.1, P2 two-tier implementation): all mod handlers registered
 * for an event are chained into ONE composite `HookCallback` carrying a
 * `modChain` marker. executeHooks (utils/hooks.ts) extracts composites from
 * the flat parallel batch and runs the mod chain as the OUTER tier wrapping
 * the core hooks — the terminal `next()` executes the core segment, so a
 * handler has true before/after semantics over the core pipeline. Without
 * mods present, the stock parallel path is untouched.
 *
 * `next()` semantics: within the mod chain, `next(e)` advances to the next
 * mod handler; the terminal `next()` runs the core tier. A handler that
 * never calls `next()` short-circuits everything below it (including core).
 */

/** P1 event subset (docs/mods-plan.md §四 P0: 7 core events). */
export const MOD_SUPPORTED_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'Notification',
] as const satisfies readonly HookEvent[]

export type ModSupportedEvent = (typeof MOD_SUPPORTED_EVENTS)[number]

export function isModSupportedEvent(
  event: string,
  // zai patch (2026-10-06):返回值收窄为纯 ModSupportedEvent —— opencc 这里
  // 原本还接受 `ui.render`(ModRenderEvent),该事件已随 TUI 能力面删除。
): event is ModSupportedEvent {
  return (MOD_SUPPORTED_EVENTS as readonly string[]).includes(event)
}

/** Per-event matcher source fields, mirroring getMatchingHooks' switch. */
const MATCHER_FIELDS: Partial<Record<ModSupportedEvent, string[]>> = {
  PreToolUse: ['tool', 'tool_name'],
  PostToolUse: ['tool', 'tool_name'],
  Notification: ['type', 'notification_type'],
  SessionStart: ['source'],
  SessionEnd: ['reason'],
  Stop: [],
  UserPromptSubmit: [],
}

/**
 * Convert a mod matcher (string or object) into the string matchQuery that
 * getMatchingHooks compares against. `ctx.on('PostToolUse', {tool:'Bash'}, h)`
 * → `'Bash'` (compared against hookInput.tool_name).
 */
export function normalizeMatcherValue(
  event: ModSupportedEvent,
  matcher: string | Record<string, unknown>,
): string | undefined {
  if (typeof matcher === 'string') {
    const trimmed = matcher.trim()
    return trimmed === '' ? undefined : trimmed
  }
  const fields = MATCHER_FIELDS[event] ?? []
  for (const field of fields) {
    const value = matcher[field]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim()
    }
  }
  return undefined
}

const MOD_HOOK_TIMEOUT_SECONDS = 10

// ---------------------------------------------------------------------------
// Streaming progress (P2 流式事件): async-generator handlers may yield
// progress strings mid-execution; they surface through the mod notice bridge
// (engine.ts subscribes this emitter to ui.notice). Plain function handlers
// are unaffected.
// ---------------------------------------------------------------------------

type ProgressListener = (modName: string, text: string) => void
const progressListeners = new Set<ProgressListener>()

export function subscribeModProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener)
  return () => {
    progressListeners.delete(listener)
  }
}

function emitModProgress(modName: string, chunk: unknown): void {
  if (typeof chunk !== 'string' || chunk === '') return
  for (const listener of progressListeners) {
    try {
      listener(modName, chunk)
    } catch (error) {
      logForDebugging(
        `[mods] progress listener error: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

async function invokeModHandler(
  modName: string,
  handler: ModChainEntry['handler'],
  e: Record<string, unknown>,
  next: (e?: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const returned = await handler(e, next)
  // Async-generator handler (streaming): yield* progress strings, use the
  // generator's return value as the result.
  if (
    returned &&
    typeof (returned as AsyncGenerator)[Symbol.asyncIterator] === 'function'
  ) {
    const gen = returned as AsyncGenerator<unknown, unknown, unknown>
    let step = await gen.next()
    while (!step.done) {
      emitModProgress(modName, step.value)
      step = await gen.next()
    }
    const final = step.value
    return final && typeof final === 'object'
      ? (final as Record<string, unknown>)
      : { continue: true }
  }
  return returned && typeof returned === 'object'
    ? (returned as Record<string, unknown>)
    : { continue: true }
}

/**
 * Run the mod handler chain (in order) over `input`, threading `next()`.
 * The terminal `next` is the core tier runner. Each handler is individually
 * try/caught — a throwing handler is attributed to its mod, recorded for the
 * circuit breaker, and skipped (never tears the chain or kills the pipeline).
 */
export async function runModChain(
  chain: ModChainEntry[],
  input: Record<string, unknown>,
  terminal: (e: Record<string, unknown>) => Promise<Record<string, unknown>>,
  signal?: AbortSignal,
  onError?: (modName: string, error: unknown) => void,
  /**
   * zai patch (2026-10-06):当前会话 id。用于 mainAgent `mods` 槽的
   * per-session 门禁 —— 不可见的 mod 其 handler 直接跳过(仍占 next() 链位,
   * 语义上等价于该 handler 是透传)。
   */
  sessionId?: string,
): Promise<Record<string, unknown>> {
  let index = 0
  const runFrom = async (
    current: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (signal?.aborted) return { continue: true }
    if (index >= chain.length) return terminal(current)
    const { modName, handler } = chain[index]!
    index++
    // 门禁:该 mod 在本会话不可见 → 跳过 handler,但仍然往下走 next(),
    // 核心 tier 语义完全不变。
    if (!isModVisibleForSession(modName, sessionId)) {
      return runFrom(current)
    }
    // `index` is shared by every nested next(), so a handler that calls next()
    // more than once would otherwise advance the cursor twice and re-run the
    // remaining handlers plus the core terminal tier for the same event. Once a
    // branch has consumed a position, further calls on that handler's next()
    // become no-ops returning the branch's own result.
    const branchResults = new Map<
      () => Promise<Record<string, unknown>>,
      Promise<Record<string, unknown>>
    >()
    const next = (e?: Record<string, unknown>) => {
      const prior = branchResults.get(next)
      if (prior) return prior
      const branch = runFrom(e ?? current)
      branchResults.set(next, branch)
      return branch
    }
    try {
      const result = await invokeModHandler(modName, handler, current, next)
      recordModHandlerSuccess(modName)
      return result
    } catch (error) {
      logForDebugging(
        `[mods] handler error from mod "${modName}": ${error instanceof Error ? error.message : String(error)}`,
      )
      logError(
        error instanceof Error
          ? error
          : new Error(`[mods:${modName}] ${String(error)}`),
      )
      recordModHandlerFailure(modName)
      onError?.(modName, error)
      // Attribute and skip to the next handler — a broken mod must not
      // tear the chain or the pipeline (R8 mitigation).
      return runFrom(current)
    }
  }
  return runFrom(input)
}

/** Default terminal for contexts without a core tier (tests, outside-REPL). */
async function continueTerminal(): Promise<Record<string, unknown>> {
  return { continue: true }
}

/**
 * Build the composite callback for one (event, matcher) group. The composite
 * carries a `modChain` marker so executeHooks can hoist it into the outer
 * tier; the callback itself is the fallback used when no tier wrap applies
 * (e.g. executeHooksOutsideREPL).
 */
export function createCompositeModCallback(
  event: HookEvent,
  chain: ModChainEntry[],
): HookCallback['callback'] {
  return async (
    input: HookInput,
    _toolUseID: string | null,
    abort: AbortSignal | undefined,
  ) => {
    return runModChain(chain, input, continueTerminal, abort) as Awaited<
      ReturnType<HookCallback['callback']>
    >
  }
}

/**
 * Build the HookCallbackMatchers for all currently loaded mods, grouped by
 * (event, matcher). Mod load order defines chain order within a group.
 */
export function buildModHookMatchers(mods: readonly LoadedMod[]): {
  byEvent: Partial<Record<HookEvent, HookCallbackMatcher[]>>
  refs: HookCallbackMatcher[]
} {
  const groups = new Map<string, ModChainEntry[]>()
  const groupKeys = new Map<string, { event: HookEvent; matcher?: string }>()

  for (const mod of mods) {
    for (const spec of mod.handlers) {
      const key = `${spec.event}\0${spec.matcher ?? ''}`
      const group = groups.get(key) ?? []
      group.push({ modName: mod.manifest.name, handler: spec.handler })
      groups.set(key, group)
      groupKeys.set(key, { event: spec.event, matcher: spec.matcher })
    }
  }

  const byEvent: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {}
  const refs: HookCallbackMatcher[] = []
  for (const [key, chain] of groups) {
    const { event, matcher } = groupKeys.get(key)!
    const matcherEntry: HookCallbackMatcher = {
      matcher,
      hooks: [
        {
          type: 'callback',
          timeout: MOD_HOOK_TIMEOUT_SECONDS,
          callback: createCompositeModCallback(event, chain),
          modChain: chain,
        },
      ],
      pluginName: `mod:${chain.map(c => c.modName).join('+')}`,
    }
    ;(byEvent[event] ??= []).push(matcherEntry)
    refs.push(matcherEntry)
  }
  return { byEvent, refs }
}

// ── zai patch (2026-10-06):ui.render 事件链（hasModRenderHandlers /
// getModRenderChain / runModRenderChainSync）已随 TUI 能力面删除 —— 它在 React
// render 期间跑同步字符串变换，唯一消费方是 opencc 的 PromptInput 渲染管线；
// 实测这三个导出在 vendor 里零调用方。详见 engine.ts 文件头的能力面说明。
