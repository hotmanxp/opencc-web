/**
 * `createHeadlessContext` — public surface (thin module).
 *
 * The actual implementation lives in `createHeadlessContext-impl.ts`
 * and pulls in many vendored opencc-src modules whose ambient types
 * (MACRO, React 19, etc.) are not part of the server public surface.
 *
 * This file is the "thin module" the brief requires for the server
 * emit. It only:
 *   1. Defines the public types LOCALLY (no transitive imports) so
 *      the emitted d.ts is self-contained.
 *   2. Re-exports the runtime implementation from the impl file
 *      under the public `createHeadlessContext` name.
 *
 * The TS error budget for this file is zero. The mechanical d.ts
 * emit (`tsc -p tsconfig.server.json`) writes only this file's
 * declaration; the impl file's transitive vendored imports don't
 * leak into the published types. Runtime contract is locked by
 * vitest in `test/unit/server/headless-context.test.ts`.
 *
 * See `scripts/verify-server-types-self-contained.mjs` for the
 * post-build guard that rejects any cross-module import in this
 * surface.
 */

/**
 * Minimal stand-ins for vendor types we need in the public API.
 * We declare them locally (not imported) so the d.ts is
 * self-contained — the verify script rejects any cross-module
 * import. The runtime impl casts to/from these at the boundary.
 */
export interface HeadlessAppStateStore {
  getState: () => Record<string, unknown>
  setState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void
  subscribe: (listener: () => void) => () => void
}

export interface HeadlessTool {
  readonly name: string
  readonly inputSchema?: unknown
  readonly description?: unknown
}

export type HeadlessTools = readonly HeadlessTool[]

export interface HeadlessCanUseToolFn {
  (tool: HeadlessTool, input: unknown, context: unknown, assistantMessage: unknown, toolUseId: unknown, forceDecision?: unknown): Promise<unknown>
}

export interface HeadlessMCPServerConnection {
  readonly name?: string
  readonly [key: string]: unknown
}

export interface HeadlessCommand {
  readonly name?: string
  readonly [key: string]: unknown
}

/**
 * Inputs to the headless bootstrap. Every value is required and
 * read from `process.*` only as a fallback — the server passes its
 * own `cwd` and `dataDir` rather than relying on the ambient process
 * environment, which keeps the factory testable and multi-session-safe.
 */
export interface CreateHeadlessContextOptions {
  /** Project working directory; this is the cwd the runtime queries against. */
  cwd: string
  /**
   * Per-runtime data directory. Vendor reads settings from
   * `${dataDir}/settings.json` via `enableConfigs()`; for tests this
   * is a tempdir, for server it is the host's zai data dir.
   */
  dataDir: string
  /** Stable identifier for log correlation; carried on the context only. */
  runtimeId: string
  /**
   * Vendor `STATE.clientType`. Defaults to `'zai-server'` so the 17+
   * vendor code paths that branch on `clientType` (auth preference,
   * analytics, settings sources) take the server branch. Override
   * only for tests or alternate surfaces.
   */
  clientType?: string
  /**
   * Initial permission mode for the AppState. Defaults to `'default'`
   * which routes tool permission through vendor's rules; the server
   * may upgrade to `'bypassPermissions'` or `'acceptEdits'` per-session
   * via `appState.setState(...)`.
   */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  /**
   * Whether to connect MCP servers during bootstrap. Defaults to `true`
   * (current behaviour). zai-server sets this to `false` because the
   * user's `~/.zai.json` MCP config can list servers that block the
   * headless bootstrap indefinitely; the server connects MCP
   * servers lazily via the QueryEngine's own per-query refresh path
   * (or `/mcp` slash command) so startup is fast and the HTTP listener
   * binds even when MCP config is broken.
   */
  connectMcp?: boolean
  /**
   * Whether the session is treated as an interactive OpenCC CLI
   * (`STATE.isInteractive`). Defaults to `true` — verified against
   * the real zai Web UI that permission asks and AskUserQuestion still
   * bridge to the web (headlessPermissionBridge / AskUserQuestion
   * wrapper intercept at the tool layer regardless of this flag).
   * Pass `false` for SDK / headless mode: vendor branches read
   * `getIsNonInteractiveSession() === true` (exposed via
   * `zai dev --sdk` / `zai start --sdk`).
   */
  isInteractive?: boolean
}

/**
 * Per-context non-React state surface. `cwd` / `dataDir` / `clientType`
 * echo the inputs so downstream Task 4 can build a `SdkContext` for
 * `runWithSdkContext` without re-reading the options object; `isInteractive`
 * mirrors `STATE.isInteractive` so callers can assert the headless
 * invariant at-a-glance.
 */
export interface HeadlessContextConfig {
  cwd: string
  dataDir: string
  runtimeId: string
  clientType: string
  isInteractive: boolean
  permissionMode: CreateHeadlessContextOptions['permissionMode']
  /**
   * Whether MCP bootstrap ran during context construction. zai-server
   * sets `false` so startup is not blocked by the user's MCP config;
   * `true` for tests and other surfaces that want the full set of
   * MCP tools registered up-front.
   */
  connectMcp: boolean
}

/**
 * Hooks surface is intentionally narrow for Task 2. The vendor
 * `captureHooksConfigSnapshot` already runs as part of bootstrap; Task 4
 * may extend this to include pre-loaded plugin hooks and a hook-event
 * dispatcher. We document the current shape so future Tasks know which
 * fields are stable to add.
 */
export interface HeadlessContextHooks {
  /** True when `captureHooksConfigSnapshot()` completed without throwing. */
  snapshotCaptured: boolean
}

/**
 * MCP client surface. We populate `clients` / `tools` / `commands`
 * via `getMcpToolsCommandsAndResources(...)` during bootstrap; if the
 * MCP connect fails (no MCP servers configured, network error, etc.)
 * we fall back to empty arrays so headless contexts still boot. Task 4
 * may add `reconnect` / `listConfiguredServers` helpers here.
 */
export interface HeadlessContextMcp {
  clients: HeadlessMCPServerConnection[]
  tools: HeadlessTool[]
  commands: HeadlessCommand[]
}

/**
 * Sandbox surface. `available` mirrors `SandboxManager.isSandboxingEnabled()`;
 * `manager` exposes the raw vendor object for the small set of callers
 * that need `initialize(sandboxAskCallback)` (Task 4 wires the
 * server-side ask callback). Initialization is deferred — calling
 * `SandboxManager.initialize(...)` would require a StructuredIO-shaped
 * ask callback we don't have at Task 2 time.
 *
 * The `manager` type is left as `unknown` in the public d.ts; callers
 * that need to invoke it should import the concrete vendor type from
 * `@zn-ai/zn-agent-core` directly (Task 4's wiring does this).
 */
export interface HeadlessContextSandbox {
  available: boolean
  manager: unknown
}

/**
 * Sessions placeholder. Task 3 owns the vendor session/transcript
 * facade; for Task 2 we return a minimal object so callers can take
 * a stable dependency on `ctx.sessions` and forward-declare the
 * Task 3 API (`create` / `get` / `list` / `read` / `patch` /
 * `remove` / `append` / `compact`).
 */
export interface HeadlessContextSessions {
  /** Stable marker so Task 3 can detect a Task 2 placeholder. */
  placeholder: true
}

/**
 * The headless context. Every field is non-null; the factory fails
 * fast (throws) if any subsystem cannot be brought up, with the
 * exception of MCP which gracefully degrades to empty arrays (MCP
 * is optional — most headless contexts have no MCP servers configured
 * at boot).
 */
export interface HeadlessContext {
  config: HeadlessContextConfig
  appState: HeadlessAppStateStore
  tools: HeadlessTools
  permission: HeadlessCanUseToolFn
  hooks: HeadlessContextHooks
  mcp: HeadlessContextMcp
  sandbox: HeadlessContextSandbox
  sessions: HeadlessContextSessions
}

// The runtime impl is excluded from the d.ts emit (so the published
// types stay self-contained) but it IS bundled into the JS output.
// `server/index.ts` imports this re-export so the runtime is reachable
// through the `./opencc-server` subpath.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { createHeadlessContextImpl } from './createHeadlessContext-impl.js'

/**
 * Build a fully-initialized headless OpenCC context keyed by the
 * caller's explicit `cwd` / `dataDir` / `runtimeId`.
 *
 * The body lives in `createHeadlessContext-impl.ts`; this declaration
 * exists only so the public surface in this file is the single source
 * of truth for the factory's signature.
 */
export const createHeadlessContext: (
  options: CreateHeadlessContextOptions,
) => Promise<HeadlessContext> = createHeadlessContextImpl