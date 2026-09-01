/**
 * Minimal naming subagent provider registry.
 *
 * Capability flags now mirror the dsh `SubagentCapabilities` shape (5 flags,
 * 2026-08-31 alignment), but this stays a naming registry: no `descriptors`,
 * no continuable children. It is just enough surface for AgentTool to route
 * `subagent_type='opencc' | 'dsh'` to a registered provider.
 *
 * Why minimal still: zai has hardcoded branches in AgentTool.tsx with
 * deep invariants (`useExactTools`, `buildForkedMessages`, `permissionMode:
 * 'bubble'`, etc.). A full DSH-style capability seam (prepareContinuable,
 * scoped lifecycles) requires the dsh kernel track and is out of scope here.
 */

export interface SubagentRequest {
  /** Model-facing short label (3-5 words); used by AgentTool for log lines only. */
  readonly description: string
  /** The task text the child agent receives. */
  readonly prompt: string
  /** Optional explicit cwd override; providers fall back to the parent session cwd. */
  readonly cwd?: string
  /** Optional explicit env overlay; providers layer on top of scrubbed parent env. */
  readonly env?: Readonly<Record<string, string>>
  /** Optional model id override; providers ignore when they don't accept one. */
  readonly model?: string
  /** Caller cancellation. Aborting before/after publication triggers cancel(). */
  readonly signal?: AbortSignal
}

/**
 * Deployment-time context for `SubagentProvider.start`. Captured at the
 * `SubagentRuntime` boundary so providers don't need to thread parent
 * session state through their own call shape.
 */
export interface SubagentContext {
  /** Parent session's cwd; providers without `inheritsParentContext` still need this. */
  readonly parentCwd?: string
  /** Parent session's env overlay; providers may opt to add to it. */
  readonly parentEnv?: Readonly<Record<string, string>>
}

/**
 * A subset-of-frame event delivered by a provider's `SubagentRun.events`.
 * The shape is intentionally lossy: agents above this seam only need
 * "something happened" + optional text/phase/raw to drive the SSE timeline.
 * Providers may emit richer frames than this; unknown fields land in `raw`.
 */
export interface SubagentEvent {
  /** Provider-defined event kind (e.g. `agentMessage`, `tool_call`, `tool_result`). */
  readonly type: string
  /** Optional human-readable text — used by AgentTool to feed SSE updates. */
  readonly text?: string
  /** Provider-defined phase descriptor (e.g. codex's `final_answer`, `null`). */
  readonly phase?: string | null
  /** Escape hatch for the provider's native frame when callers need full fidelity. */
  readonly raw?: unknown
}

export type SubagentStopReason =
  | 'completed'
  | 'error'
  | 'aborted'
  | 'max-tokens'
  | 'refusal'

/**
 * Terminal result of a one-shot delegation. Mirrors deepseek's
 * `SubagentResult` — the field list stays small so consumers
 * don't bind to provider-specific stop-reason vocabularies.
 * `refusal` + `diagnostic` align zai with dsh 0.1.2-alpha.2
 * (`subagent/src/types.ts:208-253`).
 */
export interface SubagentResult {
  /** Final assistant text content the child produced. Empty on `error`/`aborted`. */
  readonly text: string
  /** Why the run ended. Anything other than `completed` indicates partial / no result. */
  readonly stopReason: SubagentStopReason
  /** Raw error message when `stopReason !== 'completed'`. */
  readonly errorMessage?: string
  /**
   * Provider-safe detail for non-completed results (dsh parity: fixed
   * template facts only — never tool inputs, file contents, or credentials).
   */
  readonly diagnostic?: string
}

/**
 * Consumer-owned handle for a published one-shot child run. Constructed by
 * {@link SubagentProvider.start} and returned before any turn work runs.
 *
 * The two-channel pattern (events for streaming + result for terminal)
 * mirrors what AgentTool expects so SSE updates flow as the child makes
 * progress and the final tool result lands once the child settles.
 */
export interface SubagentRun {
  /** Provider-scoped run id; distinct per provider implementation. */
  readonly id: string
  /**
   * Streaming events. Consume by `for await (const ev of run.events) {…}`.
   * Implementations should keep emitting until the run settles (the result
   * resolves), after which the iterator is permitted to end.
   */
  readonly events: AsyncIterable<SubagentEvent>
  /**
   * Resolves with the terminal {@link SubagentResult} when the child
   * settles. Does NOT reject on child-level failure — those resolve with
   * `stopReason: 'error'`. Rejecting is reserved for unrepresentable
   * infrastructure faults (e.g. spawn failure the provider could not map).
   */
  readonly result: Promise<SubagentResult>
  /**
   * Cancel remaining work and reach quiescence. Idempotent. The provider
   * decides whether cancellation is best-effort (e.g. interrupt + collect)
   * or hard (e.g. tree-kill); consumers must `await cancel()`.
   */
  cancel(): Promise<void>
}

/**
 * Start-time capability flags. Aligns with dsh 0.1.2-alpha.2
 * `SubagentCapabilities` (`subagent/src/types.ts:86-92`): five required
 * booleans. zai keeps `noStartCapabilities` on each provider instance for
 * backward compat via {@link NO_START_CAPABILITIES}.
 */
export interface SubagentCapabilities {
  readonly agentOptions: boolean
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}

/** All-false capabilities — the dsh `NO_START_CAPABILITIES` equivalent. */
export const NO_START_CAPABILITIES: SubagentCapabilities = Object.freeze({
  agentOptions: false,
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
})

/**
 * Static descriptor for a subagent provider. `capabilities` widened to the
 * dsh 5-flag shape (2026-08-31); `agentRouteDefaults` mirrors dsh's optional
 * provider-owned route (`types.ts:300-346`) and requires `agentOptions`.
 */
export interface SubagentProvider {
  /** Unique registry name (e.g. `'codex'`); stable across releases. */
  readonly name: string
  /**
   * Model-facing short description of what this provider does. Surfaced
   * in AgentTool's tool description so the model knows `subagent_type`
   * values that route to a registered provider (otherwise the schema's
   * `subagent_type: z.string()` is opaque). Format intentionally mirrors
   * `AgentDefinition.whenToUse`: one sentence, action-oriented.
   */
  readonly description: string
  /**
   * Whether the child sees parent's completed-turn prefix. Descriptive:
   * AgentTool uses it to render accurate model-facing wording in tool
   * descriptions. Provider implementations honor it independently; the
   * registry does not enforce.
   */
  readonly inheritsParentContext: boolean
  /** Start-time capability flags (dsh shape). */
  readonly capabilities: SubagentCapabilities
  /**
   * Optional static provider-owned provider/model route (dsh parity:
   * requires `capabilities.agentOptions`). The dsh provider advertises it;
   * claude-code / codex omit it.
   */
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  /**
   * Establish a published one-shot child and return its handle after
   * publication. Setup is owned by the provider; a rejection implies
   * cleanup and emits no run lifecycle.
   */
  start(req: SubagentRequest, ctx: SubagentContext): Promise<SubagentRun>
}

export class SubagentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'SubagentError'
  }
}

/**
 * Naming registry of subagent providers. Backed by an insertion-ordered
 * `Map` so `list()` returns providers in registration order — useful when
 * surfacing "available agents" to the model and want a deterministic order.
 *
 * All providers live at module-process scope via {@link getSubagentRegistry};
 * tests construct their own {@link SubagentRegistry} instance to keep
 * state isolated.
 */
export class SubagentRegistry {
  readonly #providers = new Map<string, SubagentProvider>()

  /** Register a provider under its `name`. Returns the unregister disposer. */
  registerProvider(provider: SubagentProvider): () => void {
    if (this.#providers.has(provider.name)) {
      throw new SubagentError(
        'PROVIDER_ALREADY_REGISTERED',
        `subagent registry already has a provider named '${provider.name}'`,
      )
    }
    this.#providers.set(provider.name, provider)
    return () => {
      // Idempotent: removing an absent provider is a no-op (matches the
      // Cordis-effect-style "registration is effect-scoped" requirement in
      // the original plan's HMR-safety discussion).
      this.#providers.delete(provider.name)
    }
  }

  /** Look up a provider by name; undefined when absent. */
  getProvider(name: string): SubagentProvider | undefined {
    return this.#providers.get(name)
  }

  /** Registered provider names in insertion order. */
  list(): string[] {
    return Array.from(this.#providers.keys())
  }

  /**
   * Dispatch a one-shot delegation to the named provider. Throws a
   * {@link SubagentError} when no provider is registered under `name`; the
   * provider is responsible for surfacing its own failure on the returned
   * run's `result`.
   */
  async startProvider(
    name: string,
    req: SubagentRequest,
    ctx: SubagentContext = {},
  ): Promise<SubagentRun> {
    const provider = this.#providers.get(name)
    if (!provider) {
      throw new SubagentError(
        'PROVIDER_NOT_FOUND',
        `subagent registry has no provider named '${name}' (registered: ${this.list().join(', ') || '∅'})`,
      )
    }
    return provider.start(req, ctx)
  }
}

/** Process-wide singleton. Tests should construct their own {@link SubagentRegistry}. */
let _instance: SubagentRegistry | undefined
export function getSubagentRegistry(): SubagentRegistry {
  if (!_instance) _instance = new SubagentRegistry()
  return _instance
}

/** Internal — clears the singleton so tests can reset state between cases. */
export function _resetSubagentRegistryForTests(): void {
  _instance = undefined
}
