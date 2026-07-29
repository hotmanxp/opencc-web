/**
 * Default sandbox manager — single-instance holder for the zai server's
 * active `SandboxConfig`.
 *
 * zai calls `setDefaultSandboxManager(sandbox)` once during server bootstrap
 * (see `packages/zai/src/server/services/agentRuntime.ts`). The BashTool
 * system-prompt builder later reads this via `getDefaultSandboxManager()`
 * to inject the filesystem / network boundary description into the model
 * prompt so the model knows what is and isn't allowed.
 *
 * This is intentionally trivial — it is a process-local singleton, not a
 * class. The original zai-agent-core implementation was also a singleton
 * setter/getter pair; the rename keeps the call sites in zai working
 * unchanged.
 */

import type { SandboxConfig } from './runtime/types.js'

let current: SandboxConfig | undefined

export function setDefaultSandboxManager(config: SandboxConfig): void {
  current = config
}

export function getDefaultSandboxManager(): SandboxConfig | undefined {
  return current
}

/**
 * Test seam — clears the singleton so unit tests start from a known state.
 * Not part of the public API.
 */
export function __resetDefaultSandboxManagerForTests(): void {
  current = undefined
}
