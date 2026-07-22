// @ts-nocheck — zai-local stub for upstream opencc's utils/debugFilter.ts.
// Upstream is excluded from the opencc-internals cherry-pick mirror (see
// packages/zai-agent-core/scripts/sync-from-opencc.ts). Minimal exports
// needed by debug.ts → openaiClient.ts → shim runtime load chain. If a
// future task needs richer behaviour, extend THIS file rather than
// pulling upstream. Listed in HARD_EXCLUDE_FILES.

export type DebugFilter = string | null

export function parseDebugFilter(_pattern: string): DebugFilter {
  return null
}

export function shouldShowDebugMessage(_message: string, _filter: DebugFilter): boolean {
  return false
}
