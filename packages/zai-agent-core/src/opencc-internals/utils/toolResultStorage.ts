/**
 * ZAI-LOCAL PATCH of opencc/utils/toolResultStorage — extracted from
 * upstream commit at /Users/ethan/code/opencc/src/utils/toolResultStorage.ts
 * lines 34, 397-419.
 *
 * The full upstream file imports bootstrap/state, services/analytics/*,
 * utils/slowOperations — all of which chase TUI/desktop deps that should
 * NOT enter the opencc-internals mirror. We export only the symbols
 * consumed by forkedAgent.runForkedAgent (ContentReplacementState +
 * cloneContentReplacementState) plus the legacy TOOL_RESULT_CLEARED_MESSAGE
 * string used by services/api/compressToolHistory.ts.
 *
 * DO NOT add 'utils/toolResultStorage.ts' back to sync-from-opencc.ts
 * WHITELIST_PATTERNS unless downstream consumers need additional symbols.
 * When they do, follow the same local-patch pattern: pull individual
 * exports, keep imports zai-resolvable.
 */

// Message used when tool result content was cleared without persisting to file
// (verbatim from upstream line 34; consumed by services/api/compressToolHistory.ts)
export const TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]'

/**
 * Verbatim upstream type (lines 397-400). Tracks per-message tool-result
 * replacements seen so far; forkedAgent.runForkedAgent shares state between
 * the parent context and the fork to preserve prompt-cache prefixes.
 */
export type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}

/**
 * Verbatim upstream function (lines 412-419). Pure Set/Map shallow copies —
 * no upstream helpers referenced, so the body ports 1:1 without zai-local
 * substitutions.
 */
export function cloneContentReplacementState(
  source: ContentReplacementState,
): ContentReplacementState {
  return {
    seenIds: new Set(source.seenIds),
    replacements: new Map(source.replacements),
  }
}