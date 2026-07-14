/**
 * Stub for `toolResultStorage` — opencc-internals/utils was ported into the
 * zai-agent-core package with this single util file omitted. The compress
 * helper below only needs the canonical "tool_result was cleared" marker
 * string used by microCompact.ts; persistence.ts imports compressToolHistory
 * statically and that path is the only consumer of this symbol today.
 *
 * Keep the value identical to upstream OpenCC so any future sync-from-opencc
 * merge does not silently change behaviour.
 */
export const TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]'