/**
 * Ultracode effort reminder state machine.
 *
 * Tracks whether the LLM has seen the "full" enter message in the current
 * on-streak. Emits verbatim upstream text (from claude-code v2.1.177 binary
 * extract offset 212614885) as string arrays — the caller (effort command)
 * injects them into the turn via onDone({ metaMessages }) → REPL setMessages.
 */

// ── Verbatim upstream text ───────────────────────────────────────────────────

export const ULTRACODE_EFFORT_ENTER_FULL =
  'Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the Workflow tool\u2019s **Ultracode** section and quality patterns. Solo only on conversational/trivial turns.'

export const ULTRACODE_EFFORT_ENTER_SHORT =
  'Ultracode is still on — use the Workflow tool; see its Ultracode section.'

export const ULTRACODE_EFFORT_EXIT =
  'Ultracode is off — the Workflow tool\'s standard opt-in rule applies again.'

// ── Module-level state ──────────────────────────────────────────────────────

let _isOn = false
let _hasFullBeenSent = false

export function resetUltracodeReminderState(): void {
  _isOn = false
  _hasFullBeenSent = false
}

// Exported for test verification
export function getUltracodeReminderState(): { isOn: boolean; hasFullBeenSent: boolean } {
  return { isOn: _isOn, hasFullBeenSent: _hasFullBeenSent }
}

/** Returns whether the state machine thinks ultracode is on. */
export function isUltracodeReminderOn(): boolean {
  return _isOn
}

// ── State machine ───────────────────────────────────────────────────────────

/**
 * Queue an ultra_effort_enter or ultra_effort_exit reminder.
 *
 * Returns an array of reminder text strings to inject into the current turn
 * (via onDone({ metaMessages }) → REPL setMessages).
 *
 * State transitions:
 * - enter (isOn=false): emit FULL, set isOn=true, hasFullBeenSent=true
 * - enter (isOn=true): emit SHORT, hasFullBeenSent stays true
 * - exit (isOn=true): emit EXIT, set isOn=false, hasFullBeenSent=false
 * - exit (isOn=false): no-op, return []
 */
export function queueUltracodeReminder(event: 'enter' | 'exit'): string[] {
  if (event === 'enter') {
    if (_isOn) {
      // Already on — emit short (hasFullBeenSent stays true)
      return [ULTRACODE_EFFORT_ENTER_SHORT]
    }
    // First enter or re-enter after exit
    _isOn = true
    _hasFullBeenSent = true
    return [ULTRACODE_EFFORT_ENTER_FULL]
  }
  // event === 'exit'
  if (!_isOn) {
    // Already off — no-op
    return []
  }
  _isOn = false
  _hasFullBeenSent = false
  return [ULTRACODE_EFFORT_EXIT]
}
