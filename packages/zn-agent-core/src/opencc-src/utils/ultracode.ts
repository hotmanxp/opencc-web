import { getInitialSettings } from './settings/settings.ts'
import { isUltracodeReminderOn } from './ultracodeReminder.ts'
import { isUltracodeKeywordIgnored } from './ultracodeKeywordIgnored.ts'
import { findKeywordTriggerPositions } from './ultraplan/keyword.ts'
import { createUserMessage } from './messages.ts'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.ts'

/**
 * Ultracode is xhigh effort + standing dynamic-workflow orchestration.
 * Active when the session setting `ultracode` is true.
 *
 * The "ultracode" keyword (env: OPENCC_WORKFLOW_KEYWORD, default "ultracode")
 * is a separate concern — it triggers workflow parsing in the user prompt.
 * This module tracks the boolean session toggle that gates ultracode
 * behavior across the runtime.
 */
export function isUltracodeActive(): boolean {
  // Check the state machine first (reflects runtime changes from /effort command).
  // Fall back to settings for cold-start: if ultracode was set in a prior
  // session and the user hasn't run /effort yet this session.
  return isUltracodeReminderOn() || getInitialSettings().ultracode === true
}

/**
 * Whether the prompt keyword trigger that activates the Workflow tool is
 * enabled for this session. When false, REPL's detectUltracodeTrigger()
 * leaves the keyword prefix intact in the input — the model sees a
 * literal "ultracode ..." prompt. Mirrors upstream claude-code v2.1.170
 * `workflowKeywordTriggerEnabled` (default true).
 */
export function isWorkflowKeywordTriggerEnabled(): boolean {
  return getInitialSettings().workflowKeywordTriggerEnabled !== false
}

/**
 * Returns the `<system-reminder>ultracode is on|off</system-reminder>` text
 * that workflow subagents receive at spawn time. The reminder is ALWAYS
 * injected (regardless of state) so the subagent knows whether to follow
 * the ultracode block or revert to the opt-in rule — matching upstream
 * claude-code v2.1.170 behavior.
 */
function formatUltracodeReminder(active: boolean): string {
  return `<system-reminder>ultracode is ${active ? 'on' : 'off'}</system-reminder>`
}

/**
 * Returns the reminder to inject into workflow subagent system prompts.
 * Always returns the reminder (on or off) — the subagent needs to know
 * the current state to decide whether to follow the ultracode block.
 */
export function getUltracodeReminder(): string {
  return formatUltracodeReminder(isUltracodeActive())
}

/**
 * Detect whether the user prompt starts with the workflow keyword
 * (default "ultracode", overridable via OPENCC_WORKFLOW_KEYWORD). When
 * triggered, the keyword prefix is stripped from the input and `rest`
 * contains the remainder — REPL forwards `rest` to the model and the
 * WorkflowTool description tells the LLM when to invoke it.
 *
 * The `enabled` flag lets callers gate the trigger at runtime (the
 * `workflowKeywordTriggerEnabled` setting). When false, the function is
 * a no-op: returns `triggered: false` and leaves `rest` equal to the
 * original input. Defaults to true to preserve the historical behavior.
 *
 * Why require at least one whitespace after the keyword: the keyword
 * could in principle be set to a non-alphanumeric string by an env var
 * (OPENCC_WORKFLOW_KEYWORD accepts arbitrary content), and we want at
 * least one separator so a prompt that just *contains* the word (e.g.
 * "tell me about ultracode") is not misdetected.
 */
export function detectUltracodeTrigger(
  input: string,
  keyword: string,
  enabled: boolean = true,
): { triggered: boolean; keyword: string; rest: string } {
  if (!enabled) {
    return { triggered: false, keyword, rest: input }
  }
  const match = input.match(new RegExp(`^${keyword}\\s+([\\s\\S]+)$`))
  if (!match) {
    return { triggered: false, keyword, rest: input }
  }
  logEvent('tengu_workflow_keyword', {
    keyword: keyword as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  })
  return { triggered: true, keyword, rest: match[1]! }
}

/**
 * Find positions of the "ultracode" keyword in text, for the PromptInput
 * rainbow highlight and "Dynamic workflow requested" notification.
 *
 * Mirrors `findUltraplanTriggerPositions` / `findUltrareviewTriggerPositions`
 * — the helper handles quote-pair skipping, path/identifier guards (`/`,
 * `\`, `-`, `.` + word), `?` exclusion, and slash-command exclusion.
 *
 * The actual strip-on-submit happens in REPL.tsx via `detectUltracodeTrigger`
 * (which requires a separator after the keyword). The two functions are
 * intentionally separate: the typing-time highlight accepts any occurrence
 * (a user might still want feedback while composing), but the submit-time
 * detection is stricter.
 */
export function findUltracodeTriggerPositions(
  text: string,
): Array<{ word: string; start: number; end: number }> {
  return findKeywordTriggerPositions(text, 'ultracode')
}

/** Convenience: any ultracode trigger detected in text? */
export function isUltracodeKeywordTriggered(text: string): boolean {
  return findUltracodeTriggerPositions(text).length > 0
}

/**
 * Combined helper: detect trigger + check if keyword was ignored.
 * Caller can use this to drive both 'active' and 'ignored' notifications.
 *
 * See Task 4 of docs/superpowers/plans/2026-06-15-plan11-ultracode-complete-port.md.
 */
export function checkUltracodeKeywordState(
  input: string,
  keyword: string,
  enabled: boolean,
): { triggered: boolean; ignored: boolean; keyword: string; rest: string } {
  const t = detectUltracodeTrigger(input, keyword, enabled)
  return {
    triggered: t.triggered,
    ignored: isUltracodeKeywordIgnored(input, keyword, enabled, t.triggered),
    keyword: t.keyword,
    rest: t.rest,
  }
}

/**
 * The verbatim upstream reminder text delivered as a meta message when the
 * keyword trigger fires. Mirrors upstream claude-code v2.1.177's behavior
 * (binary extract offset 212614885) where the reminder is a separate
 * `isMeta: true` user message rather than an inline user-input prefix.
 */
const KEYWORD_TURN_REMINDER =
  'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the Workflow tool to fulfill the request.'

/**
 * Builds the userInput and metaMessages for a keyword-triggered turn.
 *
 * When the keyword trigger fires (trigger.triggered === true), returns:
 *   - userInput: just the raw remainder (trigger.rest), with NO
 *     <system-reminder> prefix and NO concatenation
 *   - metaMessages: a single isMeta:true user message containing the
 *     verbatim upstream reminder text
 *
 * When the trigger is not active (trigger.triggered === false), returns
 * the input unchanged with no meta messages.
 *
 * This separates the user-facing input from the model-facing meta reminder,
 * matching upstream claude-code v2.1.177's delivery mechanism.
 */
export function buildKeywordTurnRequest(
  input: string,
  trigger: { triggered: boolean; keyword: string; rest: string },
): {
  userInput: string
  // Return shape: createUserMessage() output (proper UserMessage wrapper).
  // We don't import the UserMessage type because it's not exported from
  // messages.ts; structural typing covers it.
  metaMessages: ReturnType<typeof createUserMessage>[]
} {
  if (!trigger.triggered) {
    return { userInput: input, metaMessages: [] }
  }
  return {
    userInput: trigger.rest,
    // Use createUserMessage so the reminder carries the full UserMessage
    // shape (message.{role, content} wrapper, uuid, timestamp) that
    // normalizeMessages() in src/utils/messages.ts requires. Hand-rolling
    // the message object crashes the bundle at MessagesImpl render with
    // "Cannot read properties of undefined (reading 'content')" because
    // the user-case branch accesses `message.message.content` and
    // `message.message` is undefined for the hand-rolled object.
    metaMessages: [
      createUserMessage({
        content: [{ type: 'text', text: KEYWORD_TURN_REMINDER }],
        isMeta: true,
      }),
    ],
  }
}

