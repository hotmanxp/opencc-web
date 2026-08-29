/**
 * `createPrintRuntime` — public surface (thin module), P1 of the
 * in-process print multi-session runtime.
 *
 * Plan: docs/superpowers/plans/2026-08-27-inprocess-print-multi-session-runtime.md
 *
 * Where this sits in the three-way core-runtime design (`ZAI_CORE_RUNTIME`):
 *   - default → `createOpenccRuntime` (lightweight QueryEngine wrapper, frozen)
 *   - inproc → THIS factory: one "REPL-equivalent" instance per sessionId,
 *              driving the vendor `cli/print.ts` loop in-process via
 *              `startHeadlessPrintSession` (P0 surgery), with full hooks /
 *              resume hydration / rewind / cron / steering.
 *   - spawn  → SessionRegistry (subprocess `opencc -p`), legacy escape hatch.
 *
 * The returned object satisfies `OpenccRuntimeV2` (the frozen 8-method
 * contract + `enqueue` / `interrupt` / `getSessionState`), so
 * `routes/agent.ts` and the Web UI work unchanged; steering consumers
 * capability-probe `'enqueue' in runtime`.
 *
 * Like its siblings, this file only declares the public types locally and
 * dynamic-imports the `@ts-nocheck` impl, so the emitted
 * `dist/opencc-src/server/createPrintRuntime.d.ts` stays self-contained
 * (see scripts/verify-server-types-self-contained.mjs).
 */
import type { OpenccRuntimeV2 } from './serverTypes.js'

export type {
  OpenccEnqueueInput,
  OpenccRuntimeV2,
  OpenccSteerPriority,
} from './serverTypes.js'

/**
 * P3 (plan §5): bridge hooks the zai server injects so the in-process headless
 * loop's vendor-native `control_request` (can_use_tool / elicitation) can be
 * routed to the right runtime without the runtime having to know about zai's
 * registries. Each bridge receives the ALS-resolved sessionId so concurrent
 * in-process sessions route to their own cards/decisions.
 *
 * The bridge is invoked when vendor sends a `control_request` mid-turn; the
 * runtime awaits the bridge's resolution and writes the corresponding
 * `control_response` back into the per-instance NDJSON input stream so the
 * vendor loop unblocks.
 *
 * All three bridges are optional. When a bridge is absent the runtime writes
 * a deny/cancel error response so vendor never hangs (P1 fallback preserved).
 */
export type AskBridgeInput = {
  sessionId: string
  toolUseId: string
  requestId: string
  /** Vendor control_request.request.input shape for AskUserQuestion: { questions, metadata? }. */
  input: { questions?: unknown; metadata?: unknown }
}
/**
 * Resolved AskUserQuestion answers — shape mirrors vendor's
 * `permissionPromptToolResultToPermissionDecision` parse target and zai's
 * `AskUserAnswers = Record<string, unknown>` (see compat/runtime/types.ts),
 * which is what the frontend QuestionCard POSTs back as the body of
 * `/api/agent/answer`. Vendor's canUseTool then maps `updatedInput.answers`
 * into the model's tool_result block.
 */
export type AskBridgeResult = { answers: Record<string, unknown> }
export type AskBridgeFn = (
  input: AskBridgeInput,
) => Promise<AskBridgeResult>

export type PermissionBridgeInput = {
  sessionId: string
  toolUseId: string
  requestId: string
  toolName: string
  input: unknown
  /** Permission suggestions from the vendor pre-flight (mirrors control_request.permission_suggestions). */
  permissionSuggestions?: unknown
}
export type PermissionBridgeResult = {
  behavior: 'allow' | 'deny'
  message?: string
  updatedInput?: Record<string, unknown>
}
export type PermissionBridgeFn = (
  input: PermissionBridgeInput,
) => Promise<PermissionBridgeResult>

export type ElicitationBridgeInput = {
  sessionId: string
  requestId: string
  mcpServerName: string
  message: string
  mode: 'form' | 'url'
  url?: string
  elicitationId?: string
  requestedSchema?: Record<string, unknown>
}
export type ElicitationBridgeResult = {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}
export type ElicitationBridgeFn = (
  input: ElicitationBridgeInput,
) => Promise<ElicitationBridgeResult>

export type CreatePrintRuntimeOptions = {
  /** zai data dir (settings.json, plugins, sessions root). */
  dataDir: string
  /** Default project cwd for sessions that don't pass their own. */
  defaultCwd?: string
  /** Model applied to each new instance's store unless per-query model wins. */
  defaultModel?: string
  /** Instance identity for log correlation. */
  runtimeId?: string
  /**
   * Initial permission mode per instance. Defaults to
   * 'bypassPermissions' (parity with the spawn track's Phase-A semantics);
   * per-query `permissionMode` overrides it on the instance's own store.
   */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  /**
   * zai patch (2026-08-29, plan §A): when true, mirror vendor CLI flag
   * `--allow-dangerously-skip-permissions` for the in-process headless
   * track. Forwarded to `createHeadlessContext`'s
   * `dangerouslySkipPermissions` option, which in turn locks
   * `toolPermissionContext.isBypassPermissionsModeAvailable`. Default
   * false — inproc users opt in explicitly via env
   * `ZAI_DANGEROUSLY_SKIP_PERMISSIONS=1` (or `settings.openccCliDangerouslySkip`).
   * Fails loud at construction if `permissions.disableBypassPermissionsMode === 'disable'`.
   */
  dangerouslySkipPermissions?: boolean
  /** Skip MCP bootstrap during per-session context build. Default true. */
  connectMcp?: boolean
  /** Forwarded to createHeadlessContext (STATE.isInteractive). Default true. */
  interactive?: boolean
  /** Max live instances; LRU-evicts fully-idle ones beyond this. 0 = unlimited. */
  maxSessions?: number
  /**
   * P2: idle instance TTL (minutes). Instances with no query activity longer
   * than this are disposed — transcript is already on disk, the next query
   * re-hydrates through the vendor resume chain (user-invisible). Protected
   * from eviction while a turn is active or AppState.tasks holds
   * running/pending/queued entries (background bash / async agents; plan
   * §9.3). Default 30; 0 disables.
   */
  idleTtlMin?: number
  /**
   * P3: handle vendor-native AskUserQuestion `control_request{can_use_tool}`
   * when no compat wrapper covers the call (or as a defense-in-depth path
   * alongside the existing `__zaiBridgeCtx.onYield` route). The bridge
   * receives the ALS-resolved sessionId so concurrent in-process sessions
   * each see their own card. When omitted, the runtime writes an error
   * response so vendor never hangs.
   */
  askBridge?: AskBridgeFn
  /**
   * P3: handle generic `control_request{can_use_tool}` for tools other than
   * AskUserQuestion (Bash / Edit / etc.) when a per-query permission mode
   * other than `bypassPermissions` forces the vendor canUseTool to defer to
   * the SDK host. When omitted, the runtime writes an error response.
   */
  permissionBridge?: PermissionBridgeFn
  /**
   * P3: handle MCP `control_request{elicitation}` (see print.ts:1479 +
   * structuredIO.handleElicitation). Same ALS-resolved sessionId routing
   * as the ask/permission bridges. When omitted, the runtime writes a
   * cancel response so MCP servers never block.
   */
  elicitationBridge?: ElicitationBridgeFn
}

// The impl is `@ts-nocheck` (vendor-typed); the public contract is the
// type assertion below + vitest shape tests (mirrors createOpenccRuntime).
export const createPrintRuntime = async (
  options: CreatePrintRuntimeOptions,
): Promise<OpenccRuntimeV2> => {
  const mod = await import('./createPrintRuntime-impl.js')
  return mod.createPrintRuntimeImpl(
    options,
  ) as unknown as Promise<OpenccRuntimeV2>
}
