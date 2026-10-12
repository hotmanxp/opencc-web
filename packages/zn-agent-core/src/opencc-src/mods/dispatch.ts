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
  BUILTIN_ORIGIN,
  getLoadedMods,
  isModVisibleForSession,
  recordModHandlerFailure,
  recordModHandlerSuccess,
  subscribeModSetChanged,
} from './registry.js'
import {
  MOD_EVENTS,
  MOD_HOOK_BUDGET_MS,
  canDescend,
  cloneAndFreeze,
  freeze,
  isModEventName,
  matchesMatcher,
  tierFloors,
  tierRank,
  withBudget,
  type ModEventName,
  type ModMatcher,
  type ModMatcherLeaf,
  type ModNext,
  type ModTier,
} from './protocol.js'

export { isModEventName, MOD_EVENTS }
export type { ModEventName, ModTier }

/**
 * Mod event dispatch (docs/mods-plan.md §3.3, docs/mods-upstream-contract.md).
 *
 * Tier model: handlers for one event are chained into ONE composite
 * `HookCallback` carrying a `modChain` marker. executeHooks (utils/hooks.ts)
 * extracts composites from the flat parallel batch and runs the mod chain as
 * the OUTER tier wrapping the core hooks — the terminal `next()` executes the
 * core segment, so a handler has true before/after semantics over the core
 * pipeline. Without mods present, the stock parallel path is untouched.
 *
 * Within the chain, upstream's five tiers order the handlers
 * (`prepend > user > append > builtin > core`); `runModChain` sorts by
 * `tierRank` before threading `next()`. A handler that never calls `next()`
 * short-circuits everything below it, including core.
 *
 * Matchers are structured objects evaluated against the frozen event by
 * `matchesMatcher`, not flattened to a string — upstream's four leaf kinds
 * (`===`, RegExp, any-of, partial) do not survive a string.
 */

/** The host hook system counts in seconds; upstream's budget is 10s + 1s grace. */
const MOD_HOOK_TIMEOUT_SECONDS = 10

/**
 * Where a dotted event rides on the host's hook system until its own dispatch
 * exists.
 *
 * The host still owns the trigger points (`executeHooks` keys off
 * `HookEvent`, the settings.json names), so a mod that registers a dotted name
 * is bridged onto the hook it currently shares. Only the events with a host
 * trigger appear here — an event absent from this table is registered and
 * simply never dispatched, which is why the alignment work adds real dispatch
 * points rather than renaming alone.
 *
 * `tool.call` rides on `PreToolUse`, because that is the side upstream puts it
 * on: `d.ts:3245` — "Fires when the engine is about to run a tool … Return
 * `{ deny: reason }` to refuse", and `d.ts:3254` puts `tool.check` *after* it.
 * It used to ride on `PostToolUse`, which is the after-side: wrong position,
 * no `result.deny` for a hook to read, and no way to refuse. The before-side
 * host hook already speaks `permissionDecision`, so refusing works here too —
 * see `BRIDGED_RESULT`.
 *
 * `prompt.submit` used to be here and no longer is: upstream's event carries
 * `{text, context}` where the host hook carries
 * `hookSpecificOutput.additionalContext`, and bridging it meant a mod wrote
 * the host dialect while every other event used the upstream one. It now
 * dispatches on its own at the prompt-submission site.
 */
/**
 * Stable string identity for a structured matcher (RegExp survives via
 * source+flags), so two handlers that differ only in matcher don't collapse
 * into one chain entry.
 */
function matcherKey(matcher: unknown): string {
  if (matcher === undefined) return ''
  return stableKey(matcher, new WeakSet())
}

function stableKey(value: unknown, seen: WeakSet<object>): string {
  if (value instanceof RegExp) return `/^${value.source}/${value.flags}`
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (seen.has(value)) return '"[cycle]"'
  seen.add(value)
  if (Array.isArray(value)) {
    return `[${value.map(v => stableKey(v, seen)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v, seen)}`)
    .sort()
  return `{${entries.join(',')}}`
}

const HOST_EVENT_BRIDGE: Readonly<Partial<Record<ModEventName, HookEvent>>> = {
  'tool.call': 'PreToolUse',
  'session.start': 'SessionStart',
  'session.end': 'SessionEnd',
  'turn.complete': 'Stop',
}

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
  next: ModNext,
): Promise<Record<string, unknown>> {
  // Upstream d.ts:3239 — a hook that returns nothing "is skipped: the hooks
  // beneath and core run in its place, OR ITS LAST `next` RESULT STANDS". The
  // stream chain already implements that rule; here it did not, so
  // `await next(e)` and `return next(e)` — the two natural spellings of one
  // hook — meant different things, and the losing spelling was silent: on
  // `tool.check` the rewrite never reached core, so a mod's `deny` was
  // dropped with no log and no circuit-breaker trip.
  let nextCalled = false
  let lastNext: Record<string, unknown> | undefined
  const trackingNext = (async (nextE?: Record<string, unknown>) => {
    nextCalled = true
    lastNext = await next(nextE)
    return lastNext
  }) as ModNext
  trackingNext.to = (nextE, tier) => next.to(nextE, tier)
  const standIn = (): Record<string, unknown> =>
    nextCalled && lastNext !== undefined ? lastNext : { continue: true }

  const returned = await handler(e, trackingNext)
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
      : standIn()
  }
  return returned && typeof returned === 'object'
    ? (returned as Record<string, unknown>)
    : standIn()
}

/**
 * Run the mod handler chain (in order) over `input`, threading `next()`.
 * The terminal `next` is the core tier runner. Each handler is individually
 * try/caught and individually budgeted — a throwing or overrunning handler is
 * attributed to its mod, recorded for the circuit breaker, and skipped (never
 * tears the chain or kills the pipeline). A handler whose matcher misses the
 * event is skipped without being counted either way.
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
    const entry = chain[index]!
    const { modName, handler } = entry
    index++
    // 门禁:该 mod 在本会话不可见 → 跳过 handler,但仍然往下走 next(),
    // 核心 tier 语义完全不变。
    if (!isModVisibleForSession(modName, sessionId)) {
      return runFrom(current)
    }
    // Matched against `current`, the argument this position received — which a
    // handler above may already have rewritten via next(e).
    if (entry.matcher !== undefined && !matchesMatcher(entry.matcher, current)) {
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
    const next = ((e?: Record<string, unknown>) => {
      const prior = branchResults.get(next)
      if (prior) return prior
      const branch = runFrom(e ?? current)
      branchResults.set(next, branch)
      return branch
    }) as ModNext
    // `next.to(e, tier)` — hand control to a named tier instead of the
    // adjacent one, skipping everything between. Upstream `d.ts:5241`: "prepend
    // may name append, builtin or core, append core; it never skips a tier with
    // more authority". The chain is sorted outer-to-inner by `tierRank`, so
    // walking `index` to the first entry at or below the target is the skip.
    //
    // Naming a tier this position may not reach throws, and the per-handler
    // try/catch turns that into "this handler is skipped" — the same fate as a
    // handler that throws, rather than a silent climb.
    next.to = (targetE, targetTier) => {
      if (!canDescend(entry.tier!, targetTier)) {
        throw new Error(
          `[mods:${modName}] a handler at tier ${entry.tier} may not descend ` +
            `to ${targetTier}; from ${entry.tier} the reachable tiers are ` +
            `${tierFloors(entry.tier!).join(', ') || '(none)'}`,
        )
      }
      while (
        index < chain.length &&
        tierRank(chain[index]!.tier!) < tierRank(targetTier)
      ) {
        index++
      }
      return runFrom(targetE)
    }
    try {
      const budgeted = await withBudget((hookSignal) => {
        // Unlinked in `finally`: `{ once: true }` only fires if the signal
        // aborts, and a hook that finishes in time leaves both listeners
        // attached. On a session-scoped outer signal that is one pair per hook
        // per dispatch, for the life of the session — upstream unlinks
        // explicitly (bundle @3803457: `finally { g?.() }`).
        const unlink = linkSignals(signal, hookSignal)
        try {
          return invokeModHandler(modName, handler, current, withAbort(next, unlink.signal))
        } finally {
          unlink.dispose()
        }
      })
      if (budgeted.timedOut) {
        logForDebugging(
          `[mods] handler from mod "${modName}" exceeded its ${MOD_HOOK_BUDGET_MS}ms budget — skipped`,
        )
        recordModHandlerFailure(modName)
        onError?.(modName, new Error('hook budget exceeded'))
        // The branch this handler never entered still has to run: skipping it
        // means running what is beneath it, exactly like a throw.
        return runFrom(current)
      }
      recordModHandlerSuccess(modName)
      return budgeted.value as Record<string, unknown>
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

/** An aborted outer signal must reach the hook even if its own budget has not run out. */
function linkSignals(
  outer: AbortSignal | undefined,
  inner: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (!outer) return { signal: inner, dispose: () => {} }
  if (outer.aborted) return { signal: AbortSignal.abort(), dispose: () => {} }
  const controller = new AbortController()
  const abort = () => controller.abort()
  outer.addEventListener('abort', abort)
  inner.addEventListener('abort', abort)
  return {
    signal: controller.signal,
    dispose: () => {
      outer.removeEventListener('abort', abort)
      inner.removeEventListener('abort', abort)
    },
  }
}

/** Skip the chain when the event was aborted, matching the old pre-budget behaviour. */
function withAbort(next: ModNext, signal: AbortSignal): ModNext {
  const wrapped = ((e?: Record<string, unknown>) =>
    signal.aborted
      ? Promise.resolve({ continue: true })
      : next(e)) as ModNext
  wrapped.to = (e, tier) =>
    signal.aborted
      ? Promise.resolve({ continue: true })
      : next.to(e, tier)
  return wrapped
}

/** Default terminal for contexts without a core tier (tests, outside-REPL). */
async function continueTerminal(): Promise<Record<string, unknown>> {
  return { continue: true }
}

// ---------------------------------------------------------------------------
// Stream dispatch — the path a streaming event takes.
//
// Upstream has exactly two: `turn.step` and `process.spawn` (its `vwr`
// table). Their hooks are async generators — `async function* ($, e, next)` —
// where `next(e)` is the STREAM beneath rather than a promise, and three
// shapes are distinguishable:
//
//   return yield* next(e)          pass
//   for await (c of next(e)) yield  transform
//   yield without calling next     answer alone; nothing beneath runs
//
// A hook returning nothing leaves its last `next(e)`'s result standing,
// which is why `next` records its own return value here rather than the
// caller having to track it.
//
// None of this goes through `runModChain`: that one awaits a single object
// per handler, and a handler that yields chunks has to hand those chunks
// outward rather than swallow them as progress notices.
// ---------------------------------------------------------------------------

/** Capture a generator's return value while delegating its yields. */
async function* capture<T, R>(
  gen: AsyncGenerator<T, R>,
  onResult: (value: R) => void,
): AsyncGenerator<T, R> {
  let step = await gen.next()
  while (!step.done) {
    yield step.value
    step = await gen.next()
  }
  onResult(step.value)
  return step.value
}

/**
 * Run the mod chain for a streaming event, delegating to `open` for the
 * stream beneath the last handler.
 *
 * Failure is per handler and non-fatal in the way the rest of the dispatch
 * paths are: a handler that throws mid-stream is left where it was, and the
 * chunks already yielded STAY — what comes from beneath it then flows on, so
 * a mod that breaks halfway degrades its own transform instead of silently
 * truncating the model's output.
 */
export function runModStreamChain(
  chain: ModChainEntry[],
  input: Record<string, unknown>,
  open: (
    e: Record<string, unknown>,
  ) => AsyncGenerator<unknown, unknown> | Promise<AsyncGenerator<unknown, unknown>>,
): AsyncGenerator<unknown, unknown> {
  const runFrom = async function* (
    entries: readonly ModChainEntry[],
    e: Record<string, unknown>,
  ): AsyncGenerator<unknown, unknown> {
    // `await` because a core may build its generator asynchronously —
    // `process.spawn` awaits a child_process import before it has one, and a
    // caller that forgot to await would get "no stream" rather than the
    // stream it asked for.
    if (entries.length === 0) return yield* (await open(e))
    const [entry, ...below] = entries
    const { modName, handler, matcher } = entry
    if (matcher !== undefined && !matchesMatcher(matcher, e)) {
      return yield* runFrom(below, e)
    }

    // `next(e)` opens the stream beneath THIS handler and remembers what it
    // returned, so a hook that returns nothing still resolves to the result
    // of the last stream it opened — upstream's "Returning nothing lets its
    // last next(e)'s result stand".
    //
    // The entries are passed down rather than a shared cursor advanced, so
    // each `next(e)` traverses everything beneath afresh. Upstream is
    // explicit that a second call opens a second stream; a shared cursor
    // would make the second call silently run nothing.
    let lastNextResult: unknown
    // How much of the stream beneath this handler has already taken. A
    // failure resumes past exactly this much — upstream's "the rest from
    // beneath it", which is the rest rather than all of it, and restarting
    // from the top would replay chunks the consumer already saw.
    let pulled = 0

    const beneath = (skip: number, next?: Record<string, unknown>) => {
      let remaining = skip
      const source = (async function* () {
        return yield* (await runFrom(below, next ?? e))
      })()
      return capture(
        (async function* () {
          let step = await source.next()
          while (!step.done) {
            if (remaining > 0) remaining--
            else {
              pulled++
              yield step.value
            }
            step = await source.next()
          }
          return step.value
        })(),
        value => {
          lastNextResult = value
        },
      )
    }

    const rest = (next?: Record<string, unknown>) => beneath(0, next)

    let body: unknown
    try {
      body = handler(e, rest as never)
      // A hook written as a plain function returning the generator still
      // streams; upstream's types call that an error, but refusing it would
      // break a mod that is otherwise correct at runtime.
      if (
        body &&
        typeof (body as Promise<unknown>).then === 'function' &&
        typeof (body as AsyncGenerator)[Symbol.asyncIterator] !== 'function'
      ) {
        body = await body
      }
      if (
        !body ||
        typeof (body as AsyncGenerator)[Symbol.asyncIterator] !== 'function'
      ) {
        logForDebugging(
          `[mods] "${modName}" streaming handler returned no generator — the stream beneath still runs`,
        )
        recordModHandlerFailure(modName)
        return yield* rest()
      }
    } catch (error) {
      logForDebugging(
        `[mods] "${modName}" streaming handler error: ${error instanceof Error ? error.message : String(error)}`,
      )
      logError(
        error instanceof Error
          ? error
          : new Error(`[mods:${modName}] ${String(error)}`),
      )
      recordModHandlerFailure(modName)
      return yield* rest()
    }

    let result: unknown
    try {
      result = yield* body as AsyncGenerator<unknown, unknown>
      recordModHandlerSuccess(modName)
    } catch (error) {
      logForDebugging(
        `[mods] "${modName}" streaming handler threw mid-stream: ${error instanceof Error ? error.message : String(error)}`,
      )
      logError(
        error instanceof Error
          ? error
          : new Error(`[mods:${modName}] ${String(error)}`),
      )
      recordModHandlerFailure(modName)
      // Whatever it already yielded stays on the wire, and the stream beneath
      // resumes where this handler left off rather than from its start.
      result = yield* beneath(pulled)
    }
    return result === undefined ? lastNextResult : result
  }

  return runFrom(chain, input)
}

/** Wrap a core that may build its generator asynchronously. */
async function* awaitStream<C, R>(
  stream: AsyncGenerator<C, R> | Promise<AsyncGenerator<C, R>>,
): AsyncGenerator<C, R> {
  return yield* (await stream)
}

/**
 * Run a streaming event behind the mod chain, with `core` as the stream
 * beneath every handler.
 *
 * Hands back the generator rather than draining it: the caller is the one
 * that decides when to stop pulling, and upstream's contract makes letting the
 * stream go early a meaningful act (a spawn's child is killed).
 */
export function dispatchModStream<C, R>(
  event: string,
  payload: unknown,
  core: (
    e: Record<string, unknown>,
  ) => AsyncGenerator<C, R> | Promise<AsyncGenerator<C, R>>,
): AsyncGenerator<C, R> {
  const chain = opChains.get(event)
  if (!chain || chain.length === 0) {
    // Wrapped even with nobody subscribed: `core` may build its generator
    // asynchronously (a spawn awaits its child_process import first), and
    // handing the caller the promise would break `for await` on the
    // unsubscribed path while the subscribed one worked — a difference that
    // only ever shows up in a session with no mods loaded.
    return awaitStream(core(payload as Record<string, unknown>))
  }
  const frozen = cloneAndFreeze(payload) as Record<string, unknown>
  // The chain is untyped at this layer — a handler may yield anything and
  // return anything — so the narrowing is the caller's, made once here.
  const open = (e: Record<string, unknown>) =>
    core(e) as unknown as
      | AsyncGenerator<unknown, unknown>
      | Promise<AsyncGenerator<unknown, unknown>>
  return runModStreamChain(chain, frozen, open) as AsyncGenerator<C, R>
}

/**
 * Whether any mod subscribes to a streaming event — the same zero-subscription
 * fast path `hasModHandlersFor` gives the other two paths.
 */
export function hasModStreamHandlers(event: string): boolean {
  return (opChains.get(event)?.length ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Op dispatch — the path an op event takes.
//
// An op event is a `$` method: `$.fs.read(p)` dispatches `fs.read` with the
// call's own argument, so a mod can rewrite the call or the value it resolves
// to. Half the event table is these, and none of them need a host trigger
// point: wiring the method is the wiring.
//
// This deliberately does NOT go through `buildModHookMatchers` /
// `executeHooks` — those key off the settings.json `HookEvent` names, which
// are a separate namespace this host cannot extend (see docs/
// mods-upstream-contract.md §1.3).
// ---------------------------------------------------------------------------

/** Chain lookup by event name, rebuilt when mods load or unload. */
let opChains = new Map<string, ModChainEntry[]>()

export function __setOpChainsForTesting(
  chains: Map<string, ModChainEntry[]>,
): void {
  opChains = chains
}

/**
 * The tier a handler runs in when it names none.
 *
 * Upstream `d.ts:9730-9731` — "`user` everything a person installs, `builtin`
 * the plugins bundled in the binary". Defaulting every mod to `builtin` put a
 * mod installed from disk on the wrong side of `append`, because `TIERS` puts
 * `user` outside it: the installed code was nesting inside the tier that was
 * supposed to be its outer neighbour.
 */
function defaultTierFor(mod: LoadedMod): ModTier {
  return mod.root === BUILTIN_ORIGIN ? 'builtin' : 'user'
}

/**
 * Rebuild every op chain from the loaded set.
 *
 * Subscribed rather than called from `registerLoadedMod`: that lives in
 * registry.ts, which dispatch.ts already imports, and calling back the other
 * way would close the cycle.
 */
export function refreshOpChains(): void {
  const chains = new Map<string, ModChainEntry[]>()
  for (const mod of getLoadedMods()) {
    const fallback = defaultTierFor(mod)
    for (const spec of mod.handlers) {
      const list = chains.get(spec.event) ?? []
      list.push({
        modName: mod.manifest.name,
        handler: spec.handler,
        tier: spec.tier ?? fallback,
        matcher: spec.matcher,
      })
      chains.set(spec.event, list)
    }
  }
  for (const list of chains.values()) {
    list.sort((a, b) => tierRank(a.tier!) - tierRank(b.tier!))
  }
  opChains = chains
}

subscribeModSetChanged(refreshOpChains)
refreshOpChains()

// ---------------------------------------------------------------------------
// Engine dispatch — the path an engine event takes.
//
// An engine event is one the host raises on its own schedule (`skill.prompt`
// when a skill runs, `tool.describe` when a tool is described). Unlike an op
// event it has no method to hide inside, so each one needs a named call site —
// which is exactly why an unwired engine event is easy to leave as a name.
//
// This is the third and last dispatch path:
//   op      — `$` method          → dispatchModOp / dispatchModOpSync
//   render  — inside React render → runModRenderChainSync
//   engine  — a host call site    → dispatchModEngine (this one)
// None of them goes through `executeHooks`, whose `HookEvent` keys are a
// settings.json contract this host cannot extend.
// ---------------------------------------------------------------------------

/**
 * Run the mod chain for an engine event over `payload`, then `core`.
 *
 * `core` receives whatever the chain last passed down (or the original
 * payload if nothing did) and answers. That makes a handler that only observes
 * a one-liner, and one that rewrites, the same shape — matching upstream's
 * `next(e)` semantics.
 *
 * No subscribers means the chain is empty and `core` answers untouched.
 */
export async function dispatchModEngine<T>(
  event: string,
  payload: Record<string, unknown>,
  core: (e: Record<string, unknown>) => T | Promise<T>,
): Promise<T> {
  const chain = opChains.get(event)
  if (!chain || chain.length === 0) {
    return core(payload)
  }
  const frozen = cloneAndFreeze(payload) as Record<string, unknown>
  const outcome = (await runModChain(
    chain,
    frozen,
    async current =>
      ({ continue: true, ...current }) as unknown as Record<string, unknown>,
  )) as Record<string, unknown> | undefined
  if (!outcome || typeof outcome !== 'object') {
    return core(frozen)
  }
  return core(outcome)
}

/**
 * The other engine-event shape: the one where `next(e)` resolves to what the
 * CORE computed.
 *
 * `dispatchModEngine` cannot express it. There the terminal answers
 * `{continue: true, ...event}` and the handler's return is what core runs on —
 * which is right for an event whose answer core DERIVES from the event
 * (`prompt.context`, whose documented spelling is `next({...e, blocks})`) and
 * wrong for the events upstream documents as "`next(e)` resolves to `{ sections }`"
 * (d.ts:3435 `prompt.compose`, d.ts:3450 `prompt.attachment`, d.ts:3470
 * `tool.describe`). On those the answer is what the ENGINE composed: a handler
 * cannot compute it for itself, so `next` has to answer with it. Handed
 * `{continue: true, ...facts}` instead, the documented hook
 * `dropped(await next(e), "tone")` throws on a missing `sections`, the chain
 * skips it, and the rewrite is lost with no log.
 *
 * Both rules are upstream's:
 *   - `await next(e)` → what the engine composed, for the hook to rewrite
 *   - answering WITHOUT `next` → replaces it whole (d.ts:3425 `() => ({blocks: []})`)
 *
 * A handler that returns nothing at all, or that throws, leaves the core's
 * answer standing — prompt.section's "a hook that fails passes it through".
 */
export async function dispatchModEngineResult<T>(
  event: string,
  payload: Record<string, unknown>,
  core: (e: Record<string, unknown>) => T | Promise<T>,
): Promise<T> {
  const chain = opChains.get(event)
  if (!chain || chain.length === 0) {
    return core(payload)
  }
  const frozen = cloneAndFreeze(payload) as Record<string, unknown>
  // The terminal IS the core: `next` resolves what the engine computed, rather
  // than the event the handler was handed.
  const outcome = await runModChain(chain, frozen, async current =>
    (await core(current)) as unknown as Record<string, unknown>,
  )
  return (answersNothing(outcome) ? await core(frozen) : outcome) as T
}

/**
 * Whether a chain result carries no answer.
 *
 * `invokeModHandler`'s stand-in for a handler that returned nothing and never
 * called `next` is the host hook dialect's `{continue: true}` — which on this
 * path means "pass it through", not an answer of its own.
 */
function answersNothing(outcome: unknown): boolean {
  if (outcome === undefined || outcome === null) return true
  if (typeof outcome !== 'object') return false
  const keys = Object.keys(outcome as Record<string, unknown>)
  return keys.length === 0 || (keys.length === 1 && keys[0] === 'continue')
}

/**
 * Synchronous engine dispatch, for host sites that cannot await.
 *
 * `getAttributionTexts()` is the case that forced this: it is called from
 * prompt-building on a synchronous path, and four call sites depend on its
 * answer before the turn can start. Making it async would push a promise
 * through all of them for one event, so this runs the same chain without
 * awaiting — with the same rule as `dispatchModOpSync`, a handler that returns
 * a promise is ignored and counted as a failure rather than silently passed.
 */
export function dispatchModEngineSync<T>(
  event: string,
  payload: Record<string, unknown>,
  core: (e: Record<string, unknown>) => T,
): T {
  const chain = opChains.get(event)
  if (!chain || chain.length === 0) {
    return core(payload)
  }
  const frozen = cloneAndFreeze(payload) as Record<string, unknown>
  let current = frozen
  // Index-based rather than `for…of`: `next.to` skips the handlers between this
  // position and the tier it names, which needs a cursor the loop does not have.
  let i = 0
  while (i < chain.length) {
    const { modName, handler, matcher, tier } = chain[i]!
    i++
    if (matcher !== undefined && !matchesMatcher(matcher, current)) continue
    const next = ((e?: Record<string, unknown>) => {
      if (e !== undefined) current = e as Record<string, unknown>
      return current
    }) as unknown as ModNext
    // `as ModNext['to']`: the declared type is promise-shaped because it is
    // shared with the async chains; this one answers immediately.
    next.to = ((targetE, targetTier) => {
      if (!canDescend(tier ?? 'builtin', targetTier)) {
        throw new Error(
          `[mods:${modName}] a handler at tier ${tier} may not descend to ` +
            `${targetTier}; from ${tier ?? 'builtin'} the reachable tiers are ` +
            `${tierFloors(tier ?? 'builtin').join(', ') || '(none)'}`,
        )
      }
      while (i < chain.length && tierRank(chain[i]!.tier ?? 'builtin') < tierRank(targetTier)) {
        i++
      }
      current = targetE
      return current
    }) as unknown as ModNext['to']
    let outcome: unknown
    try {
      outcome = handler(current, next)
    } catch (error) {
      logForDebugging(
        `[mods] "${modName}" ${event} handler error: ${error instanceof Error ? error.message : String(error)}`,
      )
      recordModHandlerFailure(modName)
      continue
    }
    if (outcome && typeof outcome === 'object') {
      if (typeof (outcome as Promise<unknown>).then === 'function') {
        logForDebugging(
          `[mods] "${modName}" ${event} handler returned a promise — ignored (synchronous host site)`,
        )
        recordModHandlerFailure(modName)
        continue
      }
      const obj = outcome as Record<string, unknown>
      if ('replace' in obj) return obj.replace as T
      if ('continue' in obj) return core(current)
      current = obj
    }
  }
  return core(current)
}

/**
 * Whether any mod subscribes to `event` — the check that lets a host site skip
 * building its payload when nothing is listening. Without it every call site
 * pays for a dispatch nobody reads.
 *
 * `probe` narrows that to "subscribes AND could match this payload". Upstream's
 * `Jl` (bundle @7020150, chunk `3ph567jx`):
 *
 * ```js
 * function Jl(o, e, s){
 *   let t = e && iRe(o);
 *   return (s ?? it().loadedModules).some(r =>
 *     r.hooks(o) && (e === void 0 || lUn(r.matcherFor(o), e, t)))
 * }
 * ```
 *
 * The `lUn` it leans on is an OVERLAP test, not equality — bundle
 * `chunk-ed7zyzrn`:
 *
 * ```js
 * lUn = (modMatcher, probe, schema) =>
 *   Object.entries(probe).every(([field, value]) =>
 *     b(modMatcher, {field, value}, schema && H(schema, field)))
 * b  = (m, {field, value}, s) =>
 *   Array.isArray(m) ? m.some(e => b(e, {field, value}, s))
 *                    : !isPlain(m) || !Object.hasOwn(m, field)
 *                      || aUn(m[field], value, s)
 * aUn = (actual, pattern, s) => l(actual, pattern, {test: () => true, names: s})
 * ```
 *
 * Three readings that decide the port, each taken from those lines:
 *
 * - A handler with NO matcher returns true for every probe (`!Object.hasOwn` on
 *   a matcherless handler), so the gate stays conservative: "unknown" answers
 *   yes, never no.
 * - `b` walks arrays with `some` and `l` treats any-of on either side as a
 *   match, so this is the SAME evaluator opencc already ships as
 *   `matchesMatcher` — reuse it rather than writing a second overlap engine
 *   that could drift from the dispatch-time one.
 * - Upstream narrows further with a per-event schema (`iRe` → `{table, paths}`
 *   from `H`), rejecting probe keys the event's input cannot carry. opencc has
 *   no such schema table, and inventing one is a second contract to keep in
 *   sync; a probe naming a field no matcher has answers true here, which is the
 *   safe direction.
 *
 * The probe is deliberately a PARTIAL payload — upstream passes exactly that,
 * e.g. `Jl("agent.offer", {agent: s.agentType})` (bundle @11638340).
 */
export function hasModHandlersFor(
  event: string,
  probe?: Record<string, unknown>,
): boolean {
  const chain = opChains.get(event)
  if (chain === undefined || chain.length === 0) return false
  if (probe === undefined) return true
  return chain.some(entry => matcherCouldMatch(entry.matcher, probe))
}

/**
 * Upstream's `lUn(modMatcher, probe)` — whether a declared matcher could
 * possibly hold for an event carrying `probe`'s values.
 *
 *   lUn = (m, probe) => Object.entries(probe).every(
 *     ([field, value]) => b(m, {field, value}))
 *   b   = (m, {field, value}) => Array.isArray(m) ? m.some(e => b(e, …))
 *     : !isPlainObject(m) || !Object.hasOwn(m, field) || holds(m[field], value)
 *
 * The iteration is over the PROBE's fields, not the matcher's, and that is the
 * whole point: a matcher that says nothing about a field the probe names
 * cannot rule the event out, so `b` answers true and the gate stays open. That
 * is why this cannot be `matchesMatcher(matcher, probe)` — the real evaluator
 * treats a matcher key the payload lacks as a miss, which here would silently
 * skip a live handler.
 *
 * `holds` IS `matchesMatcher`: upstream's `aUn` delegates to `l` with a
 * wildcard test, and opencc's `matchesMatcher` implements the same leaf
 * dispatch (=== / RegExp / any-of on either side / object partial).
 */
function matcherCouldMatch(
  matcher: ModMatcher | undefined,
  probe: Record<string, unknown>,
): boolean {
  if (matcher === undefined) return true
  return Object.entries(probe).every(([field, value]) =>
    fieldCouldMatch(matcher, field, value),
  )
}

function fieldCouldMatch(
  matcher: ModMatcher,
  field: string,
  value: unknown,
): boolean {
  if (Array.isArray(matcher)) {
    return (matcher as readonly ModMatcherLeaf[]).some(m =>
      fieldCouldMatch(m, field, value),
    )
  }
  // A RegExp or string leaf is not a field-map; upstream's `!isPlain(m)` makes
  // the same check, and answers true — the gate must not narrow on a shape the
  // loader already rejected at registration.
  if (matcher === null || typeof matcher !== 'object') return true
  if (!Object.hasOwn(matcher, field)) return true
  return matchesMatcher(
    (matcher as Record<string, ModMatcherLeaf>)[field],
    value,
  )
}

/**
 * The synchronous half of the op path, for `$` methods that answer
 * immediately (`$.ui.log`, `$.ui.status`, `$.tool.register`).
 *
 * These are half the UI surface, and there is no argument for leaving them
 * unhookable: a mod that cannot see a `ui.log` call cannot filter what other
 * mods say in the transcript. The contract is the same as `ui.render`'s — no
 * promise, no await — because the caller is inside a render or a redraw and
 * cannot wait.
 *
 * A handler that returns a promise is logged and treated as a failure, the way
 * `runModRenderChainSync` treats one: silently counting it as a pass is what
 * made a broken handler invisible.
 */
export function dispatchModOpSync<T>(
  event: string,
  payload: unknown,
  core: (e: Record<string, unknown>) => T,
): T {
  const chain = opChains.get(event)
  if (!chain || chain.length === 0) {
    return core(payload as Record<string, unknown>)
  }
  const frozen = cloneAndFreeze(payload) as Record<string, unknown>
  let current = frozen
  let i = 0
  while (i < chain.length) {
    const { modName, handler, matcher, tier } = chain[i]!
    i++
    if (matcher !== undefined && !matchesMatcher(matcher, current)) continue
    const next = ((e?: Record<string, unknown>) => {
      if (e !== undefined) current = e as Record<string, unknown>
      return current
    }) as unknown as ModNext
    // `as ModNext['to']`: the declared type is promise-shaped because it is
    // shared with the async chains; this one answers immediately.
    next.to = ((targetE, targetTier) => {
      if (!canDescend(tier ?? 'builtin', targetTier)) {
        throw new Error(
          `[mods:${modName}] a handler at tier ${tier} may not descend to ` +
            `${targetTier}; from ${tier ?? 'builtin'} the reachable tiers are ` +
            `${tierFloors(tier ?? 'builtin').join(', ') || '(none)'}`,
        )
      }
      while (i < chain.length && tierRank(chain[i]!.tier ?? 'builtin') < tierRank(targetTier)) {
        i++
      }
      current = targetE
      return current
    }) as unknown as ModNext['to']
    let outcome: unknown
    try {
      // The chain handler type is the async one; here `next` answers with the
      // event rather than a promise, which is the whole difference between
      // this path and `dispatchModOp`.
      outcome = handler(current, next)
    } catch (error) {
      logForDebugging(
        `[mods] "${modName}" ${event} handler error: ${error instanceof Error ? error.message : String(error)}`,
      )
      recordModHandlerFailure(modName)
      continue
    }
    if (outcome && typeof outcome === 'object') {
      if (typeof (outcome as Promise<unknown>).then === 'function') {
        // The handler broke the synchronous contract, so its output is lost.
        // Counting that as a pass is what made such mods invisible: the breaker
        // never tripped and the failure counter stayed at zero while every
        // call silently skipped the transform.
        logForDebugging(
          `[mods] "${modName}" ${event} handler returned a promise — ignored (synchronous contract)`,
        )
        recordModHandlerFailure(modName)
        continue
      }
      const obj = outcome as Record<string, unknown>
      if ('replace' in obj) return obj.replace as T
      if ('continue' in obj) return obj as T
      current = obj
    }
  }
  // `current` is whatever the last `next(e)` made of the event, so a mod that
  // rewrites an argument changes what core runs on.
  return core(current)
}

/**
 * The result a mod's chain produced for an op: a replacement value, or
 * `undefined` to mean "use what core computed".
 */
type OpOutcome =
  | { replace: unknown }
  | { passThrough: true }
  | { deny: string }

/**
 * Run `core` behind the mod chain for `event`.
 *
 * The payload is the op's own first argument, which is what upstream's
 * `NounEventRow` dispatches (`Parameters[0]`) — so a matcher reads like the
 * call it filters: `{path: /^\\.env/}` on `$.fs.read`.
 *
 * No subscribers means the chain is empty and `core` runs untouched — the
 * zero-subscription fast path upstream relies on for its gated plugins.
 */
export async function dispatchModOp<T>(
  event: string,
  payload: unknown,
  core: (e: Record<string, unknown>) => T | Promise<T>,
): Promise<T> {
  const chain = opChains.get(event)
  if (!chain || chain.length === 0) {
    return core(payload as Record<string, unknown>)
  }
  const frozen = cloneAndFreeze(payload) as Record<string, unknown>
  // Upstream dispatches `Parameters[0]` and hands whatever a hook made of it
  // to the implementation, so a mod that rewrites an argument changes what runs.
  // The terminal records it rather than calling core: core has to run after the
  // chain so a handler's `{replace}` / `{deny}` still wins over it.
  let arg = frozen
  const outcome = (await runModChain(
    chain,
    frozen,
    async current => {
      arg = current
      return { continue: true } as unknown as Record<string, unknown>
    },
  )) as unknown as OpOutcome
  if (outcome === undefined || outcome === null) {
    return core(arg)
  }
  if ('deny' in outcome && typeof outcome.deny === 'string') {
    throw new Error(`[mods] "${event}" was denied by a mod: ${outcome.deny}`)
  }
  if ('replace' in outcome) {
    return outcome.replace as T
  }
  return core(arg)
}

/**
 * Build the composite callback for one (event, matcher) group. The composite
 * carries a `modChain` marker so executeHooks can hoist it into the outer
 * tier; the callback itself is the fallback used when no tier wrap applies
 * (e.g. executeHooksOutsideREPL).
 */
/**
 * How a bridged event's argument is spelled on the way in.
 *
 * Upstream's payloads use the mod's own names — a `tool.call` hook reads
 * `e.tool` (`d.ts:3252`, and the shipped `agents-md` matches on
 * `{ tool: 'Read' }`) while the host hook input spells the same field
 * `tool_name`. A matcher that is right in every other respect misses on the
 * key, and `runModChain` skips the handler without running it: the mod
 * installs, `/plugins` shows it healthy, and nothing happens. That silence is
 * why this table exists rather than a comment.
 */
const BRIDGED_PAYLOAD: Readonly<
  Partial<Record<HookEvent, (input: HookInput) => Record<string, unknown>>>
> = {
  PreToolUse: input => {
    const { tool_name: tool, ...rest } = input as Record<string, unknown> & {
      tool_name?: string
    }
    return { ...rest, tool }
  },
}

/**
 * How a mod's answer is spelled on the way back.
 *
 * `tool.call` answers `{ deny: reason }` (`d.ts:3248`); the host hook speaks
 * `hookSpecificOutput.permissionDecision`. Without this a mod could refuse a
 * tool and the refusal went nowhere — the position was right but the veto was
 * not wired, which is the worst of the two states.
 */
const BRIDGED_RESULT: Readonly<
  Partial<Record<HookEvent, (outcome: Record<string, unknown>) => unknown>>
> = {
  PreToolUse: outcome => {
    if (typeof outcome.deny !== 'string') return outcome
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: outcome.deny,
      },
    }
  },
}

export function createCompositeModCallback(
  event: HookEvent,
  chain: ModChainEntry[],
): HookCallback['callback'] {
  const toModPayload = BRIDGED_PAYLOAD[event]
  const toHostResult = BRIDGED_RESULT[event]
  return async (
    input: HookInput,
    _toolUseID: string | null,
    abort: AbortSignal | undefined,
  ) => {
    const payload = toModPayload ? toModPayload(input) : (input as Record<string, unknown>)
    // Copied before it is frozen: `input` is the host's own hook input, shared
    // with every other hook in the batch, so freezing it in place would reach
    // past the mod chain into the host's state.
    const outcome = (await runModChain(
      chain,
      cloneAndFreeze(payload),
      continueTerminal,
      abort,
    )) as Record<string, unknown>
    return (toHostResult ? toHostResult(outcome) : outcome) as Awaited<
      ReturnType<HookCallback['callback']>
    >
  }
}

/**
 * Build the HookCallbackMatchers for all currently loaded mods, grouped by
 * (event, matcher). Within a group, chain order is upstream's tier order and
 * then mod load order.
 *
 * The grouping key serializes the matcher: two handlers share a chain only if
 * they filter identically, and a RegExp has no stable identity otherwise.
 */
export function buildModHookMatchers(mods: readonly LoadedMod[]): {
  byEvent: Partial<Record<HookEvent, HookCallbackMatcher[]>>
  refs: HookCallbackMatcher[]
} {
  const groups = new Map<string, ModChainEntry[]>()
  const groupKeys = new Map<
    string,
    { event: HookEvent; matcher?: ModMatcher }
  >()

  for (const mod of mods) {
    for (const spec of mod.handlers) {
      const hostEvent = HOST_EVENT_BRIDGE[spec.event] ?? spec.event
      const key = `${hostEvent}\0${matcherKey(spec.matcher)}`
      const group = groups.get(key) ?? []
      group.push({
        modName: mod.manifest.name,
        handler: spec.handler,
        tier: spec.tier ?? defaultTierFor(mod),
        matcher: spec.matcher,
      })
      groups.set(key, group)
      groupKeys.set(key, { event: hostEvent, matcher: spec.matcher })
    }
  }

  const byEvent: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {}
  const refs: HookCallbackMatcher[] = []
  for (const [key, chain] of groups) {
    const { event } = groupKeys.get(key)!
    // Tier order is the sort; Array#sort is stable, so handlers in the same
    // tier keep load order.
    chain.sort((a, b) => tierRank(a.tier!) - tierRank(b.tier!))
    const matcherEntry: HookCallbackMatcher = {
      // Deliberately empty. The host's matcher selects among a user's
      // settings.json hook configs by string query; a mod matcher filters a
      // structured event argument. Different questions — runModChain applies
      // the mod one itself, where it can see the (possibly rewritten) event.
      matcher: undefined,
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
