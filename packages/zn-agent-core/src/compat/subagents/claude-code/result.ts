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
  /** dsh-parity safe failure detail (fixed template; no payload content). */
  diagnostic?: string
}

/**
 * One Claude `result` frame, loosely projected (stream-json event or the
 * single json-mode frame). Field names match the CLI/SDK output.
 */
export interface ClaudeResultFrame {
  subtype?: unknown
  is_error?: unknown
  result?: unknown
  error?: unknown
}

/**
 * dsh `successfulResult` classification (`subagent-claude-code/src/run.ts:206-226`):
 * success requires `subtype === 'success'`, `is_error !== true`, and a
 * non-blank `result`. When the frame carries no `subtype` (older CLI),
 * fall back to the legacy `is_error`-only rule.
 * @returns the failure category, or `undefined` when the frame is a strict success.
 */
export function claudeResultFailureCategory(
  frame: ClaudeResultFrame,
): 'limit' | 'product-error' | 'invalid-result' | 'unknown' | undefined {
  if (typeof frame.subtype === 'string' && frame.subtype !== 'success') {
    switch (frame.subtype) {
      case 'error_max_turns':
      case 'error_max_budget_usd':
      case 'error_max_structured_output_retries':
        return 'limit'
      case 'error_during_execution':
        return 'product-error'
      default:
        return 'unknown'
    }
  }
  if (frame.is_error === true) return 'invalid-result'
  const text = typeof frame.result === 'string' ? frame.result.trim() : ''
  if (!text) return 'invalid-result'
  return undefined
}

/**
 * Safe diagnostic line (dsh template, `run.ts:81-96`): fixed facts only —
 * never tool inputs, file contents, or credentials.
 */
export function claudeFailureDiagnostic(
  category: string,
  stage: 'query-run' | 'result-frame' = 'query-run',
): string {
  return `Product subagent failure (product: Claude Code; stage: ${stage}; category: ${category})`
}

export function resolveFinalAnswer(
  events: readonly SubagentEvent[],
  outputFormat: ClaudeOutputFormat,
): ResolvedClaudeAnswer {
  if (outputFormat === CLAUDE_OUTPUT_FORMAT.json) {
    // Find the `result` raw frame; the cli emits exactly one.
    for (const ev of events) {
      if (ev.type !== 'json_result' || !ev.raw) continue
      const parsed = ev.raw as ClaudeResultFrame & Partial<ClaudeJsonResult>
      const category = claudeResultFailureCategory(parsed)
      if (category !== undefined) {
        return {
          text: '',
          stopReason: 'error',
          errorMessage:
            typeof parsed.error === 'string' && parsed.error
              ? parsed.error
              : `claude-code result frame failed (${category})`,
          diagnostic: claudeFailureDiagnostic(category, 'result-frame'),
        }
      }
      return { text: (parsed.result as string).trim(), stopReason: 'completed' }
    }
    return {
      text: '',
      stopReason: 'error',
      errorMessage: 'claude-code did not emit a result frame',
      diagnostic: claudeFailureDiagnostic('missing-result', 'result-frame'),
    }
  }

  // stream-json flavor: assemble text from assistant events, mimicking the
  // codex resolution rule (latest assistant wins; commentary never replaces).
  // Important: a `result` event with `is_error: true` is the canonical failure
  // signal — surface it ahead of any assistant text. A successful `result`
  // event carries `result: <text>` which overrides the latest assistant.
  let latestAssistant: string | null = null
  let latestResultFrame: ClaudeResultFrame | null = null
  for (const ev of events) {
    if (ev.type === 'assistant') {
      const text = ev.text ?? ''
      if (text.trim()) {
        latestAssistant = text
      }
    } else if (ev.type === 'result' && ev.raw) {
      latestResultFrame = ev.raw as ClaudeResultFrame
    }
  }

  if (latestResultFrame) {
    // dsh strict-success rule: once a `result` frame exists it is canonical —
    // a failed/blank frame is an error, not a fall-through to assistant text.
    const category = claudeResultFailureCategory(latestResultFrame)
    if (category !== undefined) {
      return {
        text: '',
        stopReason: 'error',
        errorMessage:
          typeof latestResultFrame.error === 'string' && latestResultFrame.error
            ? latestResultFrame.error
            : `claude-code result frame failed (${category})`,
        diagnostic: claudeFailureDiagnostic(category, 'result-frame'),
      }
    }
    const resultText =
      typeof latestResultFrame.result === 'string' ? latestResultFrame.result.trim() : ''
    return { text: resultText, stopReason: 'completed' }
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
      diagnostic: claudeFailureDiagnostic('invalid-result', 'result-frame'),
    }
  }
  return {
    text: '',
    stopReason: 'error',
    errorMessage: 'claude-code produced only commentary/blank messages; cannot resolve an answer',
    diagnostic: claudeFailureDiagnostic('invalid-result', 'result-frame'),
  }
}

/**
 * Stop-reason translator from Claude Code's `result` frame. Widened to the
 * dsh strict-success classification (2026-08-31): `subtype` wins, `is_error`
 * and blank `result` map to `invalid-result`.
 */
export function stopReasonFromClaudeResult(result: ClaudeResultFrame & {
  is_error?: boolean
  error?: string
}): { stopReason: 'completed' | 'error'; errorMessage?: string; diagnostic?: string } {
  const category = claudeResultFailureCategory(result)
  if (category === undefined) return { stopReason: 'completed' }
  return {
    stopReason: 'error',
    errorMessage:
      typeof result.error === 'string' && result.error
        ? result.error
        : `claude-code returned a failed result frame (${category})`,
    diagnostic: claudeFailureDiagnostic(category, 'result-frame'),
  }
}
