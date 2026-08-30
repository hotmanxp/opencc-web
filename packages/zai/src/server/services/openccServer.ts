// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P3.1-T1): shared OpenccRuntime singleton.
 *
 * Background: P3 wrapped `createReplSession` as the `ReplRuntime` adapter and
 * cast it to the OpenccRuntime shape, but the cast left the 8-method V1
 * contract (listSessions / getSession / readTranscript / patchSession /
 * removeSession / plugins) unfulfilled. P3.1-T1 instead creates a single
 * vendor `OpenccRuntime` (already implemented in zn-agent-core via
 * `createOpenccRuntime`) and:
 *   - passes it to `ReplRuntime` as constructor arg
 *   - exposes it here so RESTful route handlers (`routes/sessions.ts`,
 *     future `routes/plugins.ts` rewiring) can call the 8-method contract
 *     without going through the ReplRuntime adapter layer.
 *
 * Why module-level singleton: zai-server boots exactly one OpenccRuntime per
 * process (matching the previous `runtime = ...` field in
 * `services/agentRuntime.ts`). Multiple instances per process would multiply
 * vendor bootstrap cost (transcript loading, agent registry, MCP probes) and
 * fragment session continuity. Tests inject a fresh instance via
 * `__setOpenccRuntimeForTests`.
 *
 * Spec: docs/superpowers/specs/2026-08-30-p3.1-vendor-query-integration.md
 *      §2.3 V1 8-method + §4.1 P3.1-T1.
 */

import type {
  OpenccRuntime,
} from '@zn-ai/zn-agent-core'

let openccRuntime: OpenccRuntime | null = null

/**
 * Store the shared OpenccRuntime. Called from
 * `services/agentRuntime.ts::initAgentRuntime()` once, after the
 * `createOpenccRuntime()` factory resolves. Idempotent: subsequent calls
 * are ignored and the prior instance is preserved (matches the
 * `if (runtime) return` guard at the top of initAgentRuntime).
 */
export function setOpenccRuntime(runtime: OpenccRuntime): void {
  if (openccRuntime) return
  openccRuntime = runtime
}

/**
 * Read the shared OpenccRuntime. Returns null until
 * `initAgentRuntime()` has finished. Route handlers should treat null as
 * 503 (see `routes/sessions.ts` `runtimeOr503`).
 */
export function getOpenccRuntime(): OpenccRuntime | null {
  return openccRuntime
}

/**
 * Test seam. Clears the singleton so unit tests can swap in a mock
 * OpenccRuntime without leaking state across tests.
 */
export function __resetOpenccRuntimeForTests(): void {
  openccRuntime = null
}