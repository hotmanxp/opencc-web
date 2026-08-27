/**
 * `createPrintRuntime` — public surface (thin module), P1 of the
 * in-process print multi-session runtime.
 *
 * Plan: docs/superpowers/plans/2026-08-27-inprocess-print-multi-session-runtime.md
 *
 * Where this sits in the dual-track design (`ZAI_OPENCC_CLI`):
 *   - off    → `createOpenccRuntime` (lightweight QueryEngine wrapper, frozen)
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
