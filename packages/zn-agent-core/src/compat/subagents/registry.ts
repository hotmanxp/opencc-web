/**
 * Minimal naming subagent provider registry.
 *
 * This is *not* a full capability seam (no `SubagentCapabilities`, no
 * `descriptors`, no continuable children). It's just enough surface for
 * AgentTool to route `subagent_type='codex'` to the codex provider; a future
 * PR can migrate the existing fork / teammate / GENERAL_PURPOSE branches to
 * this registry without touching the consumer-side call sites.
 *
 * Why minimal now: zai today has hardcoded branches in AgentTool.tsx with
 * deep invariants (`useExactTools`, `buildForkedMessages`, `permissionMode:
 * 'bubble'`, etc.). A full DSH-style capability seam introduced in one PR
 * risks regressing those paths. Iterating in two steps keeps each PR scoped
 * to one new provider and one migration.
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

export type SubagentStopReason = 'completed' | 'error' | 'aborted' | 'max-tokens'

/**
 * Terminal result of a one-shot delegation. Mirrors deepseek's
 * `SubagentResult` minimally — the field list stays small so consumers
 * don't bind to provider-specific stop-reason vocabularies.
 */
export interface SubagentResult {
  /** Final assistant text content the child produced. Empty on `error`/`aborted`. */
  readonly text: string
  /** Why the run ended. Anything other than `completed` indicates partial / no result. */
  readonly stopReason: SubagentStopReason
  /** Raw error message when `stopReason !== 'completed'`. */
  readonly errorMessage?: string
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
 * Static descriptor for a subagent provider. The shape stays small on
 * purpose — `capabilities` is currently only `noStartCapabilities` (a
 * placeholder for the capability bits we may add later) so consumers
 * don't import deepseek-specific vocabulary until we have to.
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
  /**
   * Capability shape. Today only `{ noStartCapabilities: boolean }` —
   * `true` for providers that don't accept `outputSchema` / `depthLimit` /
   * `toolFilter` / `persona` overrides (codex is one). A future PR may
   * widen this to deepseek's `SubagentCapabilities` once fork/teammate
   * migrate to this registry.
   */
  readonly capabilities: { readonly noStartCapabilities: boolean }
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
