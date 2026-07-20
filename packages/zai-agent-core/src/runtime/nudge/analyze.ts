/**
 * C.1 — Continuation intent analysis (spec C §2.1).
 *
 * Pure function. **Never throws.** Returns whether the model emitted
 * text that signals "I would continue" (needs-tool) vs declared completion.
 *
 * Decision rules (in priority order):
 *   1. `lastBlockKind === 'tool_use'` → always 'complete' (already closed)
 *   2. Empty/whitespace-only text → 'complete'
 *   3. Text matches any continuation marker → 'needs-tool'
 *   4. Otherwise → 'complete'
 *
 * Markers are case-insensitive substring matches. We keep the list
 * short and language-mixed: English ("next"), Chinese (我会继续 /
 * 下一步), and the explicit `<next>` tag marker that some upstream
 * prompts emit when wrapped.
 */

export type LastBlockKind =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'mixed'

export type ContinuationIntent = 'needs-tool' | 'complete'

/**
 * Markers that indicate the model plans to do more work in a follow-up
 * turn. Order does not matter — we do substring matching.
 *
 * Free to expand (spec §7); keep deterministic and side-effect free.
 */
const CONTINUATION_MARKERS: ReadonlyArray<string> = [
  // English
  'next step',
  'i will continue',
  'continue with',
  'next,',
  // Chinese
  '我会继续',
  '下一步',
  // Explicit tag marker
  '<next>',
] as const

/**
 * Detect whether the model emitted a "I would continue" signal.
 * Pure; never throws.
 */
export function analyzeContinuationIntent(
  text: string,
  lastBlockKind: LastBlockKind,
): ContinuationIntent {
  // Rule 1: tool_use is a terminal block — by definition the model
  // finished its turn by emitting a tool call; we don't nudge.
  if (lastBlockKind === 'tool_use') {
    return 'complete'
  }

  // Rule 2: defensive — null / undefined → 'complete'.
  if (typeof text !== 'string' || text.trim().length === 0) {
    return 'complete'
  }

  // Rule 3: substring match (case-insensitive) against any marker.
  const lowered = text.toLowerCase()
  for (const marker of CONTINUATION_MARKERS) {
    // Chinese markers aren't affected by lower-casing, but toLowerCase
    // is a no-op on non-ASCII so we apply it uniformly.
    if (lowered.includes(marker.toLowerCase())) {
      return 'needs-tool'
    }
  }

  // Rule 4: default — no marker detected → model considers itself done.
  return 'complete'
}