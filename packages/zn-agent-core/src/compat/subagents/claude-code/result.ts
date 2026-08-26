import { CLAUDE_OUTPUT_FORMAT } from './wire.js'
import type { ClaudeJsonResult, ClaudeOutputFormat } from './wire.js'
import type { SubagentEvent } from '../registry.js'

/**
 * Final-answer resolution for Claude Code's `--print` mode.
 *
 * Two output flavors:
 *
 *   1. `output-format=json` — single line on stdout:
 *      `{ "type": "result", "result": "...", "is_error": false, "usage": {...} }`.
 *      Easy: just parse and read `.result`.
 *
 *   2. `output-format=stream-json` — line-delimited events. We accumulate
 *      them as `SubagentEvent`s and resolve the final text the same way
 *      we resolve Codex: latest `assistant` block wins; empty → error.
 *
 * In both modes the resolved `SubagentResult` shape is the same so the
 * bridge / consumer doesn't have to branch on output flavor.
 */

export interface ResolvedClaudeAnswer {
  text: string
  stopReason: 'completed' | 'error'
  errorMessage?: string
}

export function resolveFinalAnswer(
  events: readonly SubagentEvent[],
  outputFormat: ClaudeOutputFormat,
): ResolvedClaudeAnswer {
  if (outputFormat === CLAUDE_OUTPUT_FORMAT.json) {
    // Find the `result` raw frame; the cli emits exactly one.
    for (const ev of events) {
      if (ev.type !== 'json_result' || !ev.raw) continue
      const parsed = ev.raw as Partial<ClaudeJsonResult>
      if (typeof parsed.result !== 'string') continue
      if (parsed.is_error) {
        return {
          text: '',
          stopReason: 'error',
          errorMessage:
            parsed.error ?? 'claude-code returned is_error=true without a message',
        }
      }
      const text = parsed.result.trim()
      if (!text) {
        return {
          text: '',
          stopReason: 'error',
          errorMessage: 'claude-code produced an empty result',
        }
      }
      return { text, stopReason: 'completed' }
    }
    return {
      text: '',
      stopReason: 'error',
      errorMessage: 'claude-code did not emit a result frame',
    }
  }

  // stream-json flavor: assemble text from assistant events, mimicking the
  // codex resolution rule (latest assistant wins; commentary never replaces).
  // Important: a `result` event with `is_error: true` is the canonical failure
  // signal — surface it ahead of any assistant text. A successful `result`
  // event carries `result: <text>` which overrides the latest assistant.
  let latestAssistant: string | null = null
  let latestResultFrame: { is_error?: unknown; result?: unknown; error?: unknown } | null = null
  for (const ev of events) {
    if (ev.type === 'assistant') {
      const text = ev.text ?? ''
      if (text.trim()) {
        latestAssistant = text
      }
    } else if (ev.type === 'result' && ev.raw) {
      latestResultFrame = ev.raw as {
        is_error?: unknown
        result?: unknown
        error?: unknown
      }
    }
  }

  if (latestResultFrame) {
    const mapped = stopReasonFromClaudeResult({
      is_error: latestResultFrame.is_error === true,
      error: typeof latestResultFrame.error === 'string' ? latestResultFrame.error : undefined,
    })
    if (mapped.stopReason !== 'completed') {
      return {
        text: '',
        stopReason: 'error',
        errorMessage: mapped.errorMessage,
      }
    }
    const resultText = typeof latestResultFrame.result === 'string' ? latestResultFrame.result.trim() : ''
    if (resultText) {
      return { text: resultText, stopReason: 'completed' }
    }
    // result event with no string answer falls through to assistant resolution.
  }

  if (latestAssistant && latestAssistant.trim()) {
    return { text: latestAssistant.trim(), stopReason: 'completed' }
  }

  const sawAssistant = events.some((e) => e.type === 'assistant')
  if (!sawAssistant) {
    return {
      text: '',
      stopReason: 'error',
      errorMessage: 'claude-code produced no assistant messages before settling',
    }
  }
  return {
    text: '',
    stopReason: 'error',
    errorMessage: 'claude-code produced only commentary/blank messages; cannot resolve an answer',
  }
}

/**
 * Stop-reason translator from Claude Code's `result` event.
 * Mirrors Codex's structure but uses two booleans (`is_error`, `error`).
 */
export function stopReasonFromClaudeResult(result: {
  is_error?: boolean
  error?: string
}): { stopReason: 'completed' | 'error'; errorMessage?: string } {
  if (!result.is_error) return { stopReason: 'completed' }
  return {
    stopReason: 'error',
    errorMessage: result.error ?? 'claude-code returned is_error without a message',
  }
}
