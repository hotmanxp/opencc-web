import { CODEX_NOTIFICATION, type AgentMessageParams } from './wire.js'
import type { SubagentEvent } from '../registry.js'

/**
 * Final-answer resolution.
 *
 * Rule (mirrors deepseek-harness's `resolveResult` in `dsh-subagent-codex`):
 *
 *   1. The latest `agentMessage` with `phase === 'final_answer'` wins.
 *      When the upstream emits a single explicit final, that's the result.
 *   2. When upstream never sets an explicit phase, the latest `agentMessage`
 *      with `phase === null` is the **compatibility fallback**. The Agent
 *      Note calls this out: "When the product emits no explicit final
 *      phase, the latest message with `phase: null` is the compatibility
 *      fallback and must likewise be nonblank; commentary never replaces
 *      either answer."
 *   3. Commentary never replaces the assistant's answer — `commentary`
 *      events are surfaced via `SubagentEvent.type === 'commentary'` but
 *      never collapse into the final text.
 *   4. A successful turn without an answer (blank, or only commentary)
 *      settles as `error` — not `completed` — so callers can react.
 *
 * The function is pure: it walks the supplied event list and returns the
 * resolved text + a stopReason. The caller (`run.ts`) handles result
 * packaging + SubagentResult emission.
 */

export interface ResolvedAnswer {
  /** Resolved final answer text; empty string when no answer landed. */
  text: string
  /** Why resolution stopped where it did; mirrors SubagentStopReason. */
  stopReason: 'completed' | 'error'
  /** Diagnostic message when `stopReason === 'error'`. */
  errorMessage?: string
}

export function resolveFinalAnswer(events: readonly SubagentEvent[]): ResolvedAnswer {
  let latestFinal: AgentMessageParams | null = null
  let latestFallback: AgentMessageParams | null = null
  let rawResponse: unknown

  for (const event of events) {
    if (event.type !== CODEX_NOTIFICATION.agentMessage) continue
    const params = event.raw as AgentMessageParams | undefined
    if (!params) continue
    rawResponse = params
    if (params.phase === 'final_answer') {
      latestFinal = params
    } else if (params.phase === null || params.phase === undefined) {
      latestFallback = params
    }
  }

  const candidate = latestFinal ?? latestFallback
  const text = (candidate?.text ?? '').trim()
  if (text) {
    return { text, stopReason: 'completed' }
  }

  // No answer. If upstream did emit agentMessages, treat as 'error' with
  // a hint; otherwise the raw event list is genuinely empty.
  const emittedAgent = events.some((e) => e.type === CODEX_NOTIFICATION.agentMessage)
  const emittedCommentary = events.some((e) => e.type === CODEX_NOTIFICATION.commentary)
  if (!emittedAgent && emittedCommentary) {
    return {
      text: '',
      stopReason: 'error',
      errorMessage: 'codex produced only commentary events and no agentMessage; cannot resolve an answer',
    }
  }
  if (!emittedAgent) {
    return {
      text: '',
      stopReason: 'error',
      errorMessage: 'codex produced no agentMessage frames before settling',
    }
  }
  return {
    text: '',
    stopReason: 'error',
    errorMessage:
      'codex produced only commentary/blank messages and no final_answer; cannot resolve an answer',
  }
}

/**
 * Stop-reason translator from Codex's `turn/completed` notification.
 *
 *   - status === 'success'     → 'completed' (caller then runs resolveFinalAnswer)
 *   - status === 'error' AND codexErrorInfo === 'contextWindowExceeded'
 *                              → 'max-tokens'
 *   - status === 'error'       → 'error'   (with errorMessage)
 *   - status === 'interrupted' → 'error'   (no native `refusal` terminal)
 *
 * Why we don't have a `refusal` mapping: deepseek's Agent Note explicitly
 * states "this version has no native refusal terminal". We follow suit —
 * callers can treat `error` stops as the universal fallback and surface
 * `errorMessage` to the model.
 */
export interface CodexTurnTerminal {
  status: 'success' | 'error' | 'interrupted'
  errorMessage?: string
  codexErrorInfo?: string
}

export function stopReasonFromTurnTerminal(
  terminal: CodexTurnTerminal,
): {
  stopReason: 'completed' | 'max-tokens' | 'error' | 'aborted'
  errorMessage?: string
} {
  if (terminal.status === 'success') return { stopReason: 'completed' }
  if (terminal.status === 'interrupted') {
    return {
      stopReason: 'error',
      errorMessage: terminal.errorMessage ?? 'codex turn interrupted',
    }
  }
  if (terminal.codexErrorInfo === 'contextWindowExceeded') {
    return { stopReason: 'max-tokens' }
  }
  return {
    stopReason: 'error',
    errorMessage: terminal.errorMessage ?? 'codex turn failed without an error message',
  }
}
