/**
 * Local AgentRuntime contract placeholder — consumed by
 * `DefaultBackgroundRuntime` until Batch 2d introduces the unified
 * `compat/runtime/contract.ts`.
 *
 * The real `AgentRuntime` interface (with `run(opts): AsyncIterable<RuntimeEvent>`)
 * is owned by the runtime shim. Until then, this structural placeholder gives
 * `DefaultBackgroundRuntimeOptions.agentRuntime` a stable type so that
 * downstream code (`BackgroundAgentTool` etc.) compiles against it.
 *
 * Once `compat/runtime/contract.ts` lands, this file re-exports from there.
 */

export interface AgentRuntime {
  run(opts: unknown): AsyncIterable<Record<string, unknown>>
}
