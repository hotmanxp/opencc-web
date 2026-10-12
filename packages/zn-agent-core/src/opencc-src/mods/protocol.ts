/**
 * Official Mods protocol core (docs/mods-upstream-contract.md).
 *
 * Everything here is pure logic with no host imports, so it can be reasoned
 * about (and tested) without a running TUI. Three things live here:
 *
 * 1. The event table — the 109 dotted event names upstream registers. Two
 *    sources feed one `on()`: engine events the host emits, and op events
 *    that are `$`'s own methods (so a mod can hook a host action, not just a
 *    lifecycle point).
 * 2. The tier chain — `prepend > user > append > builtin > core`, with the
 *    floors `next.to(e, tier)` may hand control to.
 * 3. The guard pieces — frozen event arguments, the structured matcher
 *    evaluator, and the per-hook budget.
 *
 * Why dotted names instead of the host's `HookEvent`: `HookEvent` is the
 * user-facing settings.json API re-exported from the Agent SDK
 * (`src/entrypoints/agentSdkTypes.js`) — `PreToolUse`, `PostToolUse` and
 * friends are a contract with the user's own hook scripts. Mod events are a
 * separate namespace and stay separate, which is also how upstream ships
 * them (classic `*` hooks and dotted mod events coexist in one table).
 */

// ---------------------------------------------------------------------------
// 1. Event table
// ---------------------------------------------------------------------------

/**
 * Events the host emits on its own. Grouped the way the upstream docs group
 * them; `turn.*` and `session.*` are long because a session and a turn are
 * where most observation happens.
 */
export const MOD_ENGINE_EVENTS = [
  // prompt
  'prompt.submit',
  'prompt.read',
  'prompt.fill',
  'prompt.suggest',
  'prompt.edit',
  'prompt.autocomplete',
  'prompt.section',
  'prompt.context',
  'prompt.attachment',
  'prompt.mention',
  'prompt.compose',
  // tool
  'tool.call',
  'tool.check',
  'tool.describe',
  'tool.list',
  'tool.register',
  // session
  'session.start',
  'session.end',
  'session.send',
  'session.receive',
  'session.append',
  'session.attach',
  'session.detach',
  'session.messages',
  'session.cwd',
  'session.root',
  'session.model',
  'session.turns',
  'session.id',
  'session.repo',
  'session.surfaces',
  'session.surface',
  'session.version',
  'session.compact',
  'session.authorize',
  'session.measure',
  // turn
  'turn.start',
  'turn.complete',
  'turn.step',
  'turn.abort',
  // ui
  'ui.render',
  'ui.resolve',
  'ui.press',
  'ui.input',
  'ui.select',
  'ui.message',
  'ui.scroll',
  'ui.focus',
  'ui.blit',
  'ui.copy',
  'ui.notify',
  'ui.fault',
  // agents and the rest
  'agent.offer',
  'agent.spawn',
  'command.describe',
  'config.describe',
  'model.complete',
  'model.fork',
  'model.classify',
  'attribution.text',
  'skill.prompt',
  'plugin.register',
  // Folds the engine's nouns into a `$`: a plugin answers with the nouns it
  // wants to add and the ones it wants withheld. This is how `$.telemetry`
  // exists at all.
  'engine.create',
] as const

/**
 * Op events: every method on `$` dispatches one, so a mod can intercept a
 * host action (`fs.read`, `process.run`) rather than only wait for a
 * lifecycle hook. This is the mechanism upstream's own mods lean on —
 * `cc-plugin-telemetry` ADDs `$.telemetry` through `engine.create` and the
 * others call it.
 */
export const MOD_OP_EVENTS = [
  // fs
  'fs.read',
  'fs.write',
  'fs.list',
  'fs.exists',
  'fs.stat',
  'fs.ancestors',
  // store
  'store.get',
  'store.set',
  'store.delete',
  'store.keys',
  // clock
  'clock.now',
  'clock.sleep',
  'clock.after',
  'clock.every',
  // misc host capabilities
  'http.fetch',
  'process.run',
  'process.spawn',
  'settings.read',
  'state.get',
  'state.set',
  'env.get',
  'env.set',
  'flag.value',
  'audio.play',
  'audio.speak',
  'mcp.call',
  'mcp.connect',
  'model.complete',
  // Added by the telemetry plugin through `engine.create`; every other plugin
  // calls it, so it has to be hookable like any other noun.
  'telemetry.log',
  'telemetry.mark',
  // registrations
  'tool.register',
  'tool.list',
  'command.run',
  'command.list',
  'command.register',
  'config.list',
  'config.set',
  'agent.register',
  'agent.list',
  // Upstream types this as `OpEventOf['session.usage']` (d.ts:6936) — it is
  // `$.session.usage()`, a method on `$`, so a hook observes the CALL rather
  // than waiting for the host to raise one.
  'session.usage',
  'prompt.submit',
  'prompt.read',
  'prompt.compose',
  'turn.abort',
  // ui
  'ui.open',
  'ui.close',
  'ui.panes',
  'ui.status',
  'ui.toast',
  'ui.log',
  'ui.notice',
  'ui.invalidate',
  'ui.selection',
] as const

export const MOD_EVENTS = [
  ...new Set<string>([...MOD_ENGINE_EVENTS, ...MOD_OP_EVENTS]),
] as readonly string[]

const MOD_EVENT_SET = new Set(MOD_EVENTS)

export type ModEngineEvent = (typeof MOD_ENGINE_EVENTS)[number]
export type ModOpEvent = (typeof MOD_OP_EVENTS)[number]
export type ModEventName = ModEngineEvent | ModOpEvent

export function isModEventName(event: string): boolean {
  return MOD_EVENT_SET.has(event)
}

/**
 * Events this host cannot implement, and why.
 *
 * The point is that there is no third bucket. Every name in the table is
 * either dispatchable (its host trigger, or — for op events — its `$` method,
 * which *is* the trigger) or refused here by name. An event that registers
 * without doing anything is worse than one that never existed, because the mod
 * author finds out at runtime, in the one place they are not looking.
 *
 * Only audio falls out: opencc renders to a terminal and has no device to
 * play through. Everything else upstream lists has somewhere to land here —
 * the desktop / mobile / vscode element tables are `$` *components* rather
 * than events, so they never reach this table.
 */
export const UNAVAILABLE_EVENTS: Readonly<Record<string, string>> = {
  'audio.play': 'opencc renders to a terminal and has no audio device',
  'audio.speak': 'opencc renders to a terminal and has no audio device',
  'ui.blit':
    'opencc has no raster or pixel pipeline — `$.ui.blit` repaints a mounted Raster with cells, and a terminal has neither',
  'ui.message':
    'opencc has no surface bus: `$.ui.message` delivers a message to a surface (desktop app, mobile, VS Code) and the only surface here is the terminal itself',
  'ui.fault':
    'opencc has no surface fault channel: `$.ui.fault` reports a failure to a non-terminal surface, and there is none to report to',
  'prompt.autocomplete':
    'opencc completes no token: `prompt.autocomplete` answers `{text, cursor, token, start}` with suggestions for the token under the cursor. The nearest thing here — PromptSuggestion — predicts the NEXT prompt from an EMPTY box (`inputValue.length > 0 ? null : suggestionText`), takes no text/cursor/token, and never runs mid-typing. Wiring that to this name would hand a ported token-completer silently different behaviour, which is the shell this event is refused to become.',
  // zai patch (2026-10-12, mods 同步):上游把 ui.render 留在表里,因为它的
  // 渲染点是 PromptInput(React/Ink)。zai 的 UI 是 Web UI,这条渲染路径不存在,
  // 同源的 hasModRenderHandlers / getModRenderChain / runModRenderChainSync 与
  // mods/renderTap.ts 已整体删除。
  //
  // **不拒它就会落进「注册成功但永不触发」那第三种状态** —— 比报错更坏:
  // mod 以为改写生效了,实际什么都没发生。按本文件自己定的规矩
  // (「要么真能 dispatch,要么按名字拒掉」),这里明确拒掉。
  'ui.render':
    'zai has no React/Ink render pass: `ui.render` is a synchronous text transform that upstream runs inside PromptInput\'s render. zai\'s UI is a Web UI, so there is no such render site to hook — the whole ui.render chain (hasModRenderHandlers / runModRenderChainSync / renderTap) is not present in this host.',
}

/** Why `event` cannot be dispatched here, or undefined if it can. */
export function unavailabilityReason(event: string): string | undefined {
  return UNAVAILABLE_EVENTS[event]
}


/**
 * Events whose result the host caches and re-serves until invalidated by
 * `$.ui.invalidate(event)`. A hook on one of these that returns a promise
 * settles once; a hook that changed state should call invalidate to force a
 * recompute.
 */
export const INVALIDATABLE_EVENTS: readonly ModEventName[] = [
  'ui.render',
  'prompt.section',
  'prompt.context',
  'prompt.attachment',
  'tool.describe',
  'command.describe',
  'config.describe',
]

export function isInvalidatableEvent(event: string): boolean {
  return (INVALIDATABLE_EVENTS as readonly string[]).includes(event)
}

// ---------------------------------------------------------------------------
// 2. Tier chain
// ---------------------------------------------------------------------------

/** Outer to inner. Same order as upstream's `TIERS`. */
export const TIERS = ['prepend', 'user', 'append', 'builtin', 'core'] as const
export type ModTier = (typeof TIERS)[number]

const TIER_ORDER = new Map<string, number>(TIERS.map((t, i) => [t, i]))

export function tierRank(tier: ModTier): number {
  return TIER_ORDER.get(tier) ?? TIERS.length
}

/**
 * Floors a tier may hand control to via `next.to(e, tier)`. `user` and
 * `builtin` and `core` are leaves — a handler there cannot re-enter anything
 * beneath itself, which is what stops a mod from looping.
 */
const TIER_FLOORS: Record<ModTier, readonly ModTier[]> = {
  prepend: ['append', 'builtin', 'core'],
  user: [],
  append: ['core'],
  builtin: [],
  core: [],
}

export function tierFloors(tier: ModTier): readonly ModTier[] {
  return TIER_FLOORS[tier]
}

export function canDescend(from: ModTier, to: ModTier): boolean {
  return TIER_FLOORS[from].includes(to)
}

// ---------------------------------------------------------------------------
// 3. Frozen event arguments
// ---------------------------------------------------------------------------

/**
 * Upstream hands every hook a deeply frozen `e`: writing `e.command = "ls"`
 * throws instead of silently editing the value the engine set. Mods change
 * state by passing a new object to `next(e)`, never by mutation.
 *
 * Frozen shallowly would let `e.nested.thing = 1` through, which is the
 * mutation that actually shows up in practice — so this walks.
 */
export function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value as object)) return value
  seen.add(value as object)
  if (Array.isArray(value)) {
    for (const item of value) freeze(item, seen)
    return Object.freeze(value)
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    freeze((value as Record<string, unknown>)[key], seen)
  }
  return Object.freeze(value)
}

/**
 * The error a mod sees when it mutates the frozen event. Names the event and
 * the field, because a bare "cannot assign to read only property" in a mod's
 * console is useless.
 *
 * Exported and read by nothing. A mod writing `e.command` hits V8's own
 * `TypeError` from the strict-mode assignment, not this. Wiring it in means
 * a Proxy around every dispatched payload — a real cost on a path that runs
 * for every tool call — so it stays unused until that cost is worth paying.
 */

/**
 * Freeze a copy, so the caller's object is left alone.
 *
 * `freeze` alone is wrong wherever the event did not originate inside the mod
 * chain: the four bridged events (`tool.call`, `session.start`, `session.end`,
 * `turn.complete`) reach a handler as the host's own `HookInput`, and that
 * object is shared with every other hook in the batch. Freezing it in place
 * would not just fail to protect the event — it would freeze the host's hook
 * state out from under the rest of the chain. Upstream copies for the same
 * reason (`bundle @3797680`: `let p = s && !Object.is(n, o) ? Lo(n) : n`).
 *
 * A mod that wants a change to reach the host passes a new object to
 * `next(e)`; that is the whole contract, and it works on a copy.
 */
export function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value
  const obj = value as unknown as object
  const prior = seen.get(obj)
  if (prior !== undefined) return prior as T
  if (value instanceof Date) return new Date(value.getTime()) as T
  // An internal slot type cannot be rebuilt by copying own properties —
  // `Object.create(Map.prototype)` is not a Map. A hook writing to one of
  // these writes to the object the host shares; upstream has the same
  // exposure, and no documented event payload carries one.
  if (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof RegExp ||
    ArrayBuffer.isView(value)
  ) {
    return value
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(obj, copy)
    for (const item of value) copy.push(cloneAndFreeze(item, seen))
    return Object.freeze(copy) as T
  }
  // Prototype preserved rather than flattened, so `instanceof` still answers
  // the way the host set it up.
  const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>
  seen.set(obj, copy)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    copy[key] = cloneAndFreeze((value as Record<string, unknown>)[key], seen)
  }
  return Object.freeze(copy) as T
}

// ---------------------------------------------------------------------------
// 4. Structured matcher
// ---------------------------------------------------------------------------

/**
 * A matcher is an object literal nested against the event argument. Four leaf
 * kinds, per upstream: exact value, RegExp, any-of array, object partial.
 *
 *   { tool: 'Read' }                      // exact
 *   { text: /^think/i }                   // RegExp
 *   { origin: ['remote', 'user'] }        // any-of
 *   { instructionFiles: { kind: [...] } } // partial
 *
 * The literal restriction upstream enforces statically (no spread, no computed
 * key, no accessor) exists so `to` cannot be smuggled in as a tier — here
 * `tier` is a separate spec field, so a matcher can never override it.
 */
export type ModMatcherLeaf =
  | string
  | number
  | boolean
  | RegExp
  | readonly ModMatcherLeaf[]
  | { readonly [key: string]: ModMatcherLeaf }

export type ModMatcher = ModMatcherLeaf | { readonly [key: string]: ModMatcherLeaf }

/** Upstream's recursion cap; a self-referential matcher must not hang a host. */
export const MATCHER_MAX_DEPTH = 8

/**
 * Lift a matcher's `to` out as the tier.
 *
 * Upstream spells the tier inside the matcher object — `on('tool.call',
 * {tool:'Bash', to:'core'}, h)` — and bans spread / computed keys / accessors
 * there so nothing can forge a `to` after the fact. opencc keeps the same
 * surface but splits the field out at registration, which buys the guarantee
 * without a static scan: `tier` is its own spec field, so a matcher can never
 * smuggle one and no later code has to re-check it.
 */
export function splitTier(matcher: ModMatcher): {
  matcher?: ModMatcher
  tier?: ModTier
} {
  if (matcher === null || typeof matcher !== 'object' || matcher instanceof RegExp) {
    return { matcher }
  }
  // Upstream lifts `to` out of an array element too (bundle @3650204 recurses
  // through `rr`'s ArrayExpression branch) and refuses the name twice
  // ("names \"to\" twice in one matcher"). The two-writes-in-one-object case
  // cannot reach here — a later literal key wins at parse time, so upstream
  // only catches it with a static scan. An ARRAY can carry one `to` per
  // element, and that used to return early and leave each `to` as an ordinary
  // field: one that can never match, so the tier it asked for was dropped
  // without a word.
  if (Array.isArray(matcher)) {
    let tier: ModTier | undefined
    const rest = matcher.map(leaf => {
      const split = splitTier(leaf as ModMatcher)
      if (split.tier !== undefined) {
        if (tier !== undefined && tier !== split.tier) {
          throw new Error(
            `[mods] a matcher names "to" twice: ${tier} and ${split.tier}`,
          )
        }
        tier = split.tier
      }
      return split.matcher
    })
    return {
      matcher: rest.some(m => m !== undefined) ? (rest as ModMatcher) : undefined,
      tier,
    }
  }
  const { to, ...rest } = matcher as Record<string, unknown>
  const restMatcher =
    Object.keys(rest).length > 0 ? (rest as ModMatcher) : undefined
  if (to === undefined) {
    return { matcher: restMatcher }
  }
  if (typeof to !== 'string' || !TIER_ORDER.has(to)) {
    throw new Error(
      `[mods] matcher "to" must be one of ${TIERS.join(' / ')}, got ${JSON.stringify(to)}`,
    )
  }
  return { matcher: restMatcher, tier: to as ModTier }
}

/** A tier a hook may name — never `prepend` or `user` (d.ts:9642). */
export type ModTargetTier = Exclude<ModTier, 'prepend' | 'user'>

/**
 * `next` — run the layers beneath — with `next.to` to hand control to a named
 * tier instead of the adjacent one.
 *
 * Upstream `d.ts:5241-5243`: "A managed hook's: prepend may name append,
 * builtin or core, append core; it never skips a tier with more authority".
 * A hook may only ever descend, never climb; `canDescend` holds that table.
 *
 * Lives here rather than beside the handler type because three modules need it
 * and two of them would otherwise import each other.
 */
export type ModNext = ((
  e?: Record<string, unknown>,
) => Promise<Record<string, unknown>>) & {
  to: (e: Record<string, unknown>, tier: ModTargetTier) => Promise<Record<string, unknown>>
}

export function matchesMatcher(matcher: ModMatcher, e: unknown, depth = 0): boolean {
  if (depth > MATCHER_MAX_DEPTH) {
    return false
  }
  if (matcher instanceof RegExp) {
    if (typeof e !== 'string') return false
    // A /g or /y regex carries lastIndex between calls, so a shared matcher
    // literal would alternate true/false across turns.
    matcher.lastIndex = 0
    return matcher.test(e)
  }
  if (Array.isArray(matcher)) {
    return (matcher as readonly ModMatcherLeaf[]).some((leaf) =>
      matchesMatcher(leaf, e, depth + 1),
    )
  }
  if (matcher !== null && typeof matcher === 'object') {
    if (e === null || typeof e !== 'object') return false
    // A partial against an array matches any element — this is what
    // `{instructionFiles: {kind: ['project']}}` means: an instruction file
    // list in which some file's kind is `project`, not a list that equals it.
    //
    // No depth step: the cap is on the matcher (`d.ts` / bundle @3846258,
    // "the matcher is deeper than 8 levels"), so descending into the EVENT's
    // shape must not spend it. Counting both meant the same matcher matched or
    // missed depending on how deeply array-nested the payload happened to be.
    if (Array.isArray(e)) {
      return e.some(item => matchesMatcher(matcher, item, depth))
    }
    const source = e as Record<string, unknown>
    return Object.entries(matcher as Record<string, ModMatcherLeaf>).every(
      ([key, leaf]) =>
        Object.hasOwn(source, key) && matchesMatcher(leaf, source[key], depth + 1),
    )
  }
  // Upstream `d.ts:4921` — "a pattern against an array value holds when some
  // element matches", and it reads both sides. `{tool: 'Bash'}` against a
  // payload whose `tool` is `['Bash']` holds; the scalar branch below compared
  // `['Bash'] === 'Bash'` and never fired, so an any-of against an array field
  // silently stopped matching.
  if (Array.isArray(e)) {
    return (e as unknown[]).some(item => matchesMatcher(matcher, item, depth))
  }
  return e === matcher
}

// ---------------------------------------------------------------------------
// 5. Hook budget
// ---------------------------------------------------------------------------

/**
 * Per-hook wall clock. Upstream gives each hook ten seconds, then skips that
 * hook alone — the hooks beneath it and core run in its place.
 */
export const MOD_HOOK_BUDGET_MS = 10_000

/**
 * Upstream has three clocks here (`d.ts:4237,4245,4253`): `ms` — this budget —
 * `catchMs`, "a `.catch` handler's grace: a fresh budget from the moment it is
 * called" — and `lingerMs`, "how long a hook may keep running after
 * `next.signal` aborted".
 *
 * A `MOD_HOOK_GRACE_MS` constant used to sit here and describe itself as the
 * extra second the abort is given to land. That is `catchMs`, which belongs to
 * a handler shape this host does not have; opencc has no `.catch` hook, so the
 * constant was read by nothing. It is gone rather than renamed, because
 * `lingerMs` — the clock that actually would apply — is a different number for
 * a different purpose, and inventing it silently would claim a bound upstream
 * does not enforce here.
 */

/**
 * Run `body` under the hook budget. Reports `timedOut` so the caller can skip
 * that hook alone and continue down the chain.
 *
 * The race is the point: aborting the signal is a request, and a hook holding
 * a pending promise may never honour it. Awaiting `body` directly would hang
 * the whole event on one unresponsive mod.
 */
export async function withBudget<T>(
  body: (signal: AbortSignal) => Promise<T>,
  budgetMs = MOD_HOOK_BUDGET_MS,
): Promise<{ timedOut: boolean; value?: T }> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, budgetMs)
  })
  try {
    const settled = await Promise.race([
      body(controller.signal).then(value => ({ value })),
      expiry.then(() => ({ value: 'timeout' as const })),
    ])
    return settled.value === 'timeout'
      ? { timedOut: true }
      : { timedOut: false, value: settled.value }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}