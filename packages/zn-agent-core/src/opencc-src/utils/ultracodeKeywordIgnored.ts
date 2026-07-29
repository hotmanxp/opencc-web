/**
 * "Ultracode keyword ignored" state — fires when the user types a prompt
 * containing the ultracode keyword but the trigger regex does NOT match
 * (e.g. "tell me about ultracode" — keyword present, but no whitespace
 * separator + content).
 *
 * Upstream ground truth (binary extract 398920-398940):
 *   - "Ultracode keyword ignored for this prompt" — verbatim text
 *   - " to undo" — action text (upstream clickable; OpenCC no-op for now)
 *   - tengu_workflow_keyword_dismissed (dismiss telemetry)
 *   - tengu_workflow_keyword_restored (undo telemetry)
 *
 * See Task 4 of docs/superpowers/plans/2026-06-15-plan11-ultracode-complete-port.md.
 *
 * UX gap: OpenCC's notification system (useNotifications) is timer-only —
 * no dismiss / undo action button. Upstream's "to undo" is a clickable
 * label; OpenCC's notification auto-dismisses after the timeout. The
 * "to undo" string is exported for parity but rendered as static text.
 */

import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../services/analytics/index.ts'

/** Verbatim upstream text. */
export const KEYWORD_IGNORED_TEXT = 'Ultracode keyword ignored for this prompt'

/** Verbatim upstream action label. */
export const KEYWORD_IGNORED_UNDO_TEXT = ' to undo'

/**
 * Determine if the ultracode keyword was "ignored" for the current input.
 *
 * Returns true when:
 *  - the trigger is enabled
 *  - the input contains the keyword (case-insensitive)
 *  - the keyword did NOT match the trigger regex (i.e. won't fire)
 *
 * Mirrors the upstream heuristic: keyword present, no whitespace separator.
 * Callers (PromptInput) use this to surface the "workflow-keyword-ignored"
 * notification.
 */
export function isUltracodeKeywordIgnored(
  input: string,
  keyword: string,
  enabled: boolean,
  triggered: boolean,
): boolean {
  if (!enabled) return false
  if (triggered) return false
  return input.toLowerCase().includes(keyword.toLowerCase())
}

/**
 * Fire the dismiss telemetry (tengu_workflow_keyword_dismissed).
 * Upstream fires this when the user dismisses the "ignored" toast.
 * OpenCC's notification system auto-dismisses via timeout (no action
 * button), so callers wire this on `removeNotification('workflow-keyword-ignored')`.
 */
export function logKeywordIgnoredDismissed(): void {
  logEvent('tengu_workflow_keyword_dismissed', {
    keyword: 'ultracode' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  })
}

/**
 * Fire the restore telemetry (tengu_workflow_keyword_restored).
 * Upstream fires this when the user undoes a dismiss.
 * OpenCC's notification system does not have an undo action (out of
 * scope UX gap). This is provided for future use or programmatic
 * restoration.
 */
export function logKeywordIgnoredRestored(): void {
  logEvent('tengu_workflow_keyword_restored', {
    keyword: 'ultracode' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  })
}
