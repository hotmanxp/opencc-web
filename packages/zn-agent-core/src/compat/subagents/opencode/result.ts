import type { SubagentEvent, SubagentStopReason } from '../registry.js'
import {
  OPENCODE_FRAME,
  type OpencodeFinishReason,
  type OpencodeFrame,
  type OpencodeStepFinishPart,
  type OpencodeTextPart,
} from './wire.js'
import { opencodeFailureDiagnostic } from './invariant.js'

/**
 * Pure resolution of the opencode `--format json` event stream into a
 * terminal answer. Split out of `run.ts` so the mapping table can be frozen
 * and exercised with in-memory fixtures — a real run is not needed to prove
 * the frame→answer logic (including the auth-hang / truncated-input edge
 * cases), which keeps this deterministic under vitest.
 */

/** The bounded terminal context `run.ts` folds in from the OS process. */
export interface OpencodeTerminal {
  /** Raw `child_process` exit code (null when killed by a signal). */
  exitCode: number | null
  /** Signal name when the process was signalled (null on normal exit). */
  signal: NodeJS.Signals | null
  /** Tail of the child's stderr (capped by the pump); for error messages. */
  stderrTail: string
}

/** Resolved final answer — mirrors the claude-code / codex resolver shape. */
export interface ResolvedOpencodeAnswer {
  text: string
  stopReason: SubagentStopReason
  errorMessage?: string
  /** Provider-safe failure detail (fixed template; no payload content). */
  diagnostic?: string
}

/**
 * Project a single parsed frame onto the lossy {@link SubagentEvent} shape:
 *  - `text`        → `{ type: 'text', text: part.text, raw: frame }`
 *  - `step_start`  → `{ type: 'step_start', raw: frame }`
 *  - `step_finish` → `{ type: 'step_finish', raw: frame }`
 *  - anything else → `{ type: <frame.type | 'unknown'>, raw: frame }`
 *
 * Unknown types pass through with `raw` fidelity so the SSE timeline keeps
 * them; the final-answer rule only reads the three mapped kinds.
 */
export function opencodeFrameToEvent(frame: OpencodeFrame): SubagentEvent {
  const t = typeof frame.type === 'string' ? frame.type : 'unknown'
  if (t === OPENCODE_FRAME.text) {
    const part = frame.part as OpencodeTextPart | undefined
    const text = typeof part?.text === 'string' ? part.text : ''
    return { type: t, text, raw: frame }
  }
  return { type: t, raw: frame }
}

/**
 * Parse one stdout line. Non-JSON lines degrade to a `log` event (defensive —
 * they should not appear with `--format json`, but a stray banner must never
 * abort the run).
 */
export function opencodeLineToEvent(line: string): SubagentEvent {
  try {
    const parsed = JSON.parse(line) as OpencodeFrame
    return opencodeFrameToEvent(parsed)
  } catch {
    return { type: 'log', text: line, raw: line }
  }
}

/** Dedupe `text` events by `part.id` (last write wins), preserving order. */
export function collectOpencodeAnswerParts(
  events: readonly SubagentEvent[],
): string[] {
  const order: string[] = []
  const latest = new Map<string, string>()
  events.forEach((ev, idx) => {
    if (ev.type !== OPENCODE_FRAME.text) return
    const text = typeof ev.text === 'string' ? ev.text : ''
    if (!text.trim()) return
    const frame = ev.raw as OpencodeFrame | undefined
    const part = frame?.part as OpencodeTextPart | undefined
    // Fall back to the event index so distinct parts without an id are kept
    // separate rather than collapsing into one slot.
    const key =
      typeof part?.id === 'string' && part.id ? part.id : `__idx_${idx}`
    if (!latest.has(key)) order.push(key)
    latest.set(key, text)
  })
  return order.map((k) => latest.get(k) ?? '')
}

/** The `part` of the last `step_finish` event, if any. */
export function lastStepFinishPart(
  events: readonly SubagentEvent[],
): OpencodeStepFinishPart | null {
  let found: OpencodeStepFinishPart | null = null
  for (const ev of events) {
    if (ev.type !== OPENCODE_FRAME.stepFinish) continue
    const frame = ev.raw as OpencodeFrame | undefined
    if (frame?.part) found = frame.part as OpencodeStepFinishPart
  }
  return found
}

function normalizeTail(stderrTail: string): string {
  return stderrTail.trim().slice(-2000)
}

/**
 * Fold the event stream + process terminal facts into a {@link SubagentResult}.
 *
 * Terminal contract (spec §Event mapping):
 *  - a `step_finish` with `reason: 'stop'` and a non-blank answer → `completed`;
 *  - `reason: 'length'` → `max-tokens` (partial answer kept); `content-filter`
 *    → `refusal`; `error` / `abort` → `error`;
 *  - process exit ≠ 0 without a `step_finish` → `error` with the stderr tail;
 *  - blank answer → `error` (never `completed` with an empty text).
 *
 * Cancellation (`aborted`) is settled by `run.ts` directly, not here.
 */
export function resolveOpencodeAnswer(
  events: readonly SubagentEvent[],
  term: OpencodeTerminal,
): ResolvedOpencodeAnswer {
  const text = collectOpencodeAnswerParts(events).join('\n').trim()
  const finish = lastStepFinishPart(events)
  const reason = (finish?.reason ?? '') as OpencodeFinishReason

  if (finish) {
    switch (reason) {
      case 'length':
        return { text, stopReason: 'max-tokens' }
      case 'content-filter':
        return { text, stopReason: 'refusal' }
      case 'error':
      case 'abort':
        return {
          text: '',
          stopReason: 'error',
          errorMessage:
            normalizeTail(term.stderrTail) || `opencode step finished with reason=${reason}`,
          diagnostic: opencodeFailureDiagnostic('result-frame', 'step-error'),
        }
      case 'stop':
      default:
        if (text) return { text, stopReason: 'completed' }
        return {
          text: '',
          stopReason: 'error',
          errorMessage: 'opencode finished without an answer',
          diagnostic: opencodeFailureDiagnostic('result-frame', 'no-answer'),
        }
    }
  }

  // No `step_finish` captured.
  if (term.exitCode !== null && term.exitCode !== 0) {
    const tail = normalizeTail(term.stderrTail)
    return {
      text: '',
      stopReason: 'error',
      errorMessage: tail || `opencode exited with code ${term.exitCode}`,
      diagnostic: opencodeFailureDiagnostic('process-exit', 'exit-without-finish'),
    }
  }
  if (term.signal) {
    return {
      text: '',
      stopReason: 'error',
      errorMessage: `opencode terminated by signal ${term.signal}`,
      diagnostic: opencodeFailureDiagnostic('process-exit', 'signalled-without-finish'),
    }
  }
  // Lenient: clean exit with an answer but a missed finish frame.
  if (text) return { text, stopReason: 'completed' }
  return {
    text: '',
    stopReason: 'error',
    errorMessage: 'opencode produced no output before settling',
    diagnostic: opencodeFailureDiagnostic('process-exit', 'no-output'),
  }
}
