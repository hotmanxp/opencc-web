/**
 * Public type surface for the OpenCC server runtime seam.
 *
 * The server runtime will replace zai's in-process DefaultAgentRuntime path
 * with a long-lived runtime that owns query, abort, session CRUD, transcript
 * access and shutdown. Task 1 introduces ONLY the public type surface and
 * the `createOpenccRuntime` factory (see `./index.ts`) — implementation
 * lands in downstream Tasks. The brief explicitly requires these types so
 * the zai side has a stable shape to call against.
 *
 * Naming follows opencc-server terminology (query / getSession /
 * listSessions / readTranscript / patchSession / removeSession / shutdown
 * / abort) rather than the older in-process `AgentRuntime` shape from
 * `compat/runtime/contract.ts` so future migration off the compat shim
 * doesn't require a second rename.
 *
 * Self-contained: the public surface is intentionally minimal and does
 * NOT re-export from `compat/runtime/events.js` or
 * `compat/transcript/types.js`. Those compat modules are zai-internal
 * implementation details and are not part of the published
 * `@zn-ai/zn-agent-core/opencc-server` subpath. The downstream-generated
 * `dist/opencc-src/server/serverTypes.d.ts` therefore has zero cross-module
 * type imports — a TypeScript consumer can resolve the package subpath
 * without chasing references into the compat tree.
 *
 * Compatibility note: the shapes below are the canonical public contracts.
 * The in-process compat `RuntimeEvent` / `TranscriptMeta` / `TranscriptFile`
 * types today hold a SUPERSET of these fields — a real Task 2+ runtime
 * implementation is expected to bridge between the two via an internal
 * adapter, not by widening the public surface. If the opencc upstream
 * `RuntimeEvent` ever gains a new required field, the right place to
 * mirror it is here (with a server-specific default), not by re-exporting
 * the compat type.
 */

/**
 * Permission mode used by a session. Identical to the opencc-internal
 * `PermissionMode` but redeclared here so the server's public type
 * surface is self-contained.
 *
 * Mirrors `src/compat/permissionMode.ts` (`ExternalPermissionMode | 'auto'`).
 * If the canonical set ever changes, update both — the in-process compat
 * shim is the source of truth for the runtime, this is the public-facing
 * shape for consumers.
 */
export type OpenccPermissionMode =
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan'
  | 'auto'

/**
 * Server-facing event emitted by an `OpenccRuntime`. The runtime MUST
 * emit these on the iterator returned by `query` (and may also push
 * them out-of-band via a server-event bus — that's a Task 3+ concern).
 *
 * The shape mirrors the in-process `RuntimeEvent` so the existing SSE
 * translator at the zai layer can consume the stream without adapter
 * work, but it is declared locally rather than re-exported: the
 * published `opencc-server` d.ts must remain self-contained.
 */
export type OpenccServerEvent = {
  /** Unique event id within the session. Used for replay / dedup. */
  eventId: string
  /** Session id — used for transcript continuity + event correlation. */
  sessionId: string
  /** Millisecond timestamp at which the event was emitted. */
  ts: number
  /** 0-based turn index within the session. */
  turnIndex: number
  /** Event type discriminator (e.g. `'runtime.done'`, `'runtime.error'`). */
  type: string
  /**
   * Open-ended payload map. Provider-specific fields (text, tool use,
   * error category, etc.) hang off here. Callers type-narrow by first
   * checking `type` and then reading the expected payload keys.
   */
  [key: string]: unknown
}

/**
 * Session metadata returned by `getSession` / `listSessions`. Mirrors
 * the opencc-internal `TranscriptMeta` shape but is server-owned so the
 * published d.ts has no cross-module references.
 */
export type OpenccTranscriptMeta = {
  /** Transcript schema version. `2` is the supported shape. */
  version: 1 | 2
  /** Globally-unique transcript id. */
  transcriptId: string
  /** Working directory the session was opened with. */
  cwd: string
  /** Model id used for the session. */
  model: string
  /** Creation timestamp (ms). */
  createdAt: number
  /** Last-update timestamp (ms). */
  updatedAt: number
  /** Optional human-readable title. */
  title?: string
  /** Optional user-applied tags. */
  tags?: string[]
  /** Number of messages in the persisted transcript. */
  messageCount: number
  /** Parent session id for subagent / forked sessions. */
  parentSessionId?: string
  /** Subagent type tag, if this session was a subagent run. */
  subagentType?: string
  /** Permission mode the session was opened with. */
  permissionMode?: OpenccPermissionMode
  /**
   * zai patch: id of the provider profile the user picked when this
   * session selected its model. Lets the server-side matcher route
   * the model to the exact provider the user chose even when several
   * provider profiles share the same model name. Optional — sessions
   * persisted before this field existed keep working (the matcher
   * falls back to the first matching profile by name, legacy behavior).
   */
  providerId?: string
}

/**
 * The full transcript file returned by `readTranscript`. Mirrors the
 * opencc-internal `TranscriptFile` shape but is server-owned so the
 * published d.ts has no cross-module references.
 *
 * Note: the `messages` array is intentionally typed as `unknown[]` rather
 * than the full v2 message union. Consumers that need to read message
 * bodies should narrow off the array entries themselves; the server
 * runtime is responsible for the writer side and the persistence
 * contract is enforced by the transcript store, not by this public type.
 */
export type OpenccTranscriptFile = {
  version: 1 | 2
  transcriptId: string
  meta: OpenccTranscriptMeta
  messages: unknown[]
}

/**
 * Construction options for `createOpenccRuntime`. Mirrors the
 * zai-side wiring the existing `DefaultAgentRuntime` consumes but
 * is intentionally narrow: data dir + a per-runtime identifier are
 * the only required fields. Future Tasks can extend without breaking
 * the seam.
 */
export type OpenccRuntimeOptions = {
  /**
   * Where persisted transcripts live on disk. Mirrors `dataDir` in
   * the existing `RuntimeConfig` so call sites can pass the same
   * value through.
   */
  dataDir: string
  /**
   * Stable identifier for the runtime instance. Used in log lines
   * and in the `runtime` field of `OpenccServerEvent` to disambiguate
   * events when multiple runtimes share a process (worker pool).
   */
  runtimeId?: string
  /**
   * Default working directory for sessions that don't supply one.
   * Mirrors the implicit cwd the zai HTTP layer passes today.
   */
  defaultCwd?: string
  /**
   * Default model id for sessions that don't supply one. Falls back
   * to the runtime's built-in default.
   */
  defaultModel?: string
  /**
   * Treat sessions as an interactive OpenCC CLI (`STATE.isInteractive =
   * true`). Defaults to `true`; pass `false` for SDK / headless mode.
   * Mirrors `interactive` in `createOpenccRuntime.ts` so both
   * OpenccRuntimeOptions type definitions stay in sync.
   */
  interactive?: boolean
}

/**
 * One unit of work submitted to `OpenccRuntime.query`. Encapsulates
 * the session id, the prompt, and the working directory / model
 * overrides. The runtime is responsible for translating this into
 * whatever the upstream opencc query path expects.
 */
export type OpenccQueryInput = {
  /** Session id — used for transcript continuity + event correlation. */
  sessionId: string
  /**
   * The user prompt: a plain text string, or an array of
   * Anthropic-protocol content blocks (text / base64 image) for
   * multimodal input (e.g. screenshot attachments). Mirrors the
   * upstream `QueryEngine.submitMessage(prompt: string | ContentBlockParam[])`
   * contract. Defined locally so the public d.ts stays self-contained
   * (no bare imports — see verify-server-types-self-contained.mjs).
   */
  prompt: string | OpenccContentBlockParam[]
  /** Working directory for this query. */
  cwd: string
  /** Optional model override. */
  model?: string
  /** Optional abort signal — `query` must subscribe and stop on abort. */
  abortSignal?: AbortSignal
  /**
   * zai patch: mark this query's prompt as a system-injected meta message
   * (visible to the LLM, hidden from the transcript UI). Used for the
   * placeholder query fired when a background task completes.
   */
  isMeta?: boolean
  /**
   * zai patch: optional per-query permission mode override. When absent the
   * runtime keeps whatever mode the headless context was created with.
   */
  permissionMode?:
    | 'default'
    | 'acceptEdits'
    | 'bypassPermissions'
    | 'dontAsk'
    | 'plan'
  /**
   * zai patch: per-query provider override — routes through an
   * OpenAI-compatible shim client instead of the default Anthropic SDK path.
   */
  providerOverride?: { model: string; baseURL: string; apiKey: string }
  /**
   * zai patch: id of the provider profile the user picked for this query.
   * Lets the server-side matcher route the model to the exact provider the
   * user chose when several profiles share the same model name.
   */
  providerId?: string
}

/**
 * Content block shape accepted by `OpenccQueryInput.prompt` when a
 * query carries multimodal content. Structurally a subset of
 * Anthropic's `ContentBlockParam` (text + base64 image only — the two
 * block types zai's HTTP layer accepts today). Extra keys are allowed
 * (`[k: string]: unknown`) so future block kinds pass through without
 * widening this union.
 */
export type OpenccContentBlockParam =
  | {
      type: 'text'
      text: string
      [k: string]: unknown
    }
  | {
      type: 'image'
      source: {
        type: 'base64'
        media_type: string
        data: string
        [k: string]: unknown
      }
      [k: string]: unknown
    }

/**
 * The runtime contract every implementation must satisfy. The eight
 * methods mirror the brief verbatim:
 *
 *   - `query`              — start a new turn for a session
 *   - `abort`              — cancel an in-flight turn
 *   - `getSession`         — read one session's metadata
 *   - `listSessions`       — enumerate sessions
 *   - `readTranscript`     — read a session's persisted messages
 *   - `patchSession`       — edit session metadata (title, tags)
 *   - `removeSession`      — delete a session
 *   - `shutdown`           — graceful stop, releases all resources
 */
export type OpenccRuntime = {
  query(input: OpenccQueryInput): AsyncIterable<OpenccServerEvent>
  abort(sessionId: string, reason?: string): Promise<void>
  getSession(sessionId: string): Promise<OpenccTranscriptMeta | null>
  listSessions(opts?: {
    cwd?: string
    includeSubagent?: boolean
  }): Promise<OpenccTranscriptMeta[]>
  readTranscript(
    sessionId: string,
    opts: { cwd: string },
  ): Promise<OpenccTranscriptFile>
  patchSession(
    sessionId: string,
    patch: { title?: string; tags?: string[] },
    opts: { cwd: string },
  ): Promise<void>
  removeSession(sessionId: string, opts: { cwd: string }): Promise<void>
  shutdown(): Promise<void>
  plugins: OpenccPluginApi
}

export type OpenccPluginScope = 'user' | 'project' | 'local' | 'builtin'

export type OpenccPluginComponentCounts = {
  commands: number
  agents: number
  skills: number
  hooks: number
  mcpServers: number
}

export type OpenccPluginDto = {
  id: string
  name: string
  description?: string
  version?: string
  author?: string
  marketplace: string
  scope: OpenccPluginScope
  enabled: boolean
  writable: boolean
  hasUpdate: boolean
  components: OpenccPluginComponentCounts
  errors: string[]
}

export type OpenccMarketplacePluginDto = {
  id: string
  name: string
  description?: string
  version?: string
  author?: string
  marketplace: string
  category?: string
  tags?: string[]
  installed: boolean
  homepage?: string
}

export type OpenccPluginListResult = {
  plugins: OpenccPluginDto[]
  errors: string[]
}

export type OpenccPluginReloadCounts = {
  plugins: number
  commands: number
  agents: number
  hooks: number
  mcpServers: number
  errors: number
}

export type OpenccPluginActionResult = {
  success: boolean
  message: string
  reloadFailed?: boolean
  reload?: OpenccPluginReloadCounts
  state?: OpenccPluginListResult
}

/** A configured marketplace source, as shown in the "市场来源" tab. */
export type OpenccMarketplaceDto = {
  name: string
  /** Human-readable source, e.g. `github:owner/repo` — from getMarketplaceSourceDisplay. */
  source: string
  /** Discriminant of the underlying MarketplaceSource: github | git | url | file | directory. */
  sourceType: string
  lastUpdated?: string
  /** Plugins the marketplace declares, or undefined when its cache can't be read. */
  pluginCount?: number
  /** How many of those are currently installed. */
  installedCount: number
}

/**
 * Result of adding a marketplace. On success the fresh `marketplaces` and
 * `available` lists ride along so the UI can repaint without a refetch —
 * same convention as {@link OpenccPluginActionResult.state}.
 */
export type OpenccMarketplaceActionResult = {
  success: boolean
  message: string
  /** Resolved marketplace name (comes from its marketplace.json, not the input). */
  name?: string
  marketplaces?: OpenccMarketplaceDto[]
  available?: OpenccMarketplacePluginDto[]
}

export type OpenccPluginApi = {
  listInstalled(): Promise<OpenccPluginListResult>
  listAvailable(): Promise<OpenccMarketplacePluginDto[]>
  setEnabled(id: string, enabled: boolean): Promise<OpenccPluginActionResult>
  install(id: string): Promise<OpenccPluginActionResult>
  uninstall(id: string): Promise<OpenccPluginActionResult>
  update(id: string): Promise<OpenccPluginActionResult>
  reload(): Promise<OpenccPluginActionResult>
  listMarketplaces(): Promise<OpenccMarketplaceDto[]>
  /** `source` is raw user input — `owner/repo`, an https/git URL, or a local path. */
  addMarketplace(source: string): Promise<OpenccMarketplaceActionResult>
}
