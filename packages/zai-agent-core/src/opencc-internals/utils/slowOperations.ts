// @ts-nocheck — zai-local stub for upstream opencc's utils/slowOperations.ts.
// Upstream is excluded from the opencc-internals cherry-pick mirror (see
// packages/zai-agent-core/scripts/sync-from-opencc.ts). Minimal exports
// needed by debug.ts → openaiClient.ts → shim runtime load chain. If a
// future task needs richer behaviour, extend THIS file rather than
// pulling upstream. Listed in HARD_EXCLUDE_FILES.

export function jsonStringify(input: unknown): string {
  return JSON.stringify(input)
}
