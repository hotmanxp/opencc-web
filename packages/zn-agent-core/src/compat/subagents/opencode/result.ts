import type { SubagentEvent, SubagentStopReason } from '../registry.js'
import {
  OPENCODE_FRAME,
  type OpencodeFinishReason,
  type OpencodeFrame,
  type OpencodeReasoningPart,
  type OpencodeStepFinishPart,
  type OpencodeTextPart,
  type OpencodeToolPart,
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
 * Project a single parsed frame onto the lossy {@link SubagentEvent} shape,
 * translated into the **zai-bg vocabulary** (same intermediate dialect the
 * dsh provider emits): `mapSubagentEventType` in the pump bridges then maps
 * these onto the SSE drawer keys (`assistant_message` / `tool_use` /
 * `tool_result` / `subagent_turn_started` / `subagent_turn_completed` /
 * `commentary`). Emitting opencode's native frame names instead would fall
 * through the bridge's default branch and drop off the drawer whitelist —
 * the whole timeline renders empty (2026-09-04 fix).
 *
 * Mapping (frame vocabulary from the real-run capture, see wire.ts):
 *  - `text`        → `agentMessage`   (text = part.text, raw = frame)
 *  - `step_start`  → `turnStarted`    (raw = frame)
 *  - `step_finish` → `turnCompleted`  (raw = frame; the final-answer rule
 *                    reads `part.reason` off the LAST one — intermediate
 *                    steps carry `reason: 'tool-calls'`)
 *  - `reasoning`   → `commentary`     (text = part.text)
 *  - `tool_use`    → `toolCall` with `raw = { id, name, input }`
 *                    (TaskDrawer keys the card off raw.id / raw.name /
 *                    raw.input; opencode delivers call + settled output in
 *                    ONE frame, so a completed/error state additionally
 *                    emits a paired `toolResult` with
 *                    `raw = { tool_use_id }` that flips the card to done)
 *  - anything else → passthrough `{ type: <frame.type | 'unknown'>, raw }`
 *
 * Returns 1..2 events (tool frames with a terminal state return two).
 */
export function opencodeFrameToEvents(frame: OpencodeFrame): SubagentEvent[] {
  const t = typeof frame.type === 'string' ? frame.type : 'unknown'
  if (t === OPENCODE_FRAME.text) {
    const part = frame.part as OpencodeTextPart | undefined
    const text = typeof part?.text === 'string' ? part.text : ''
    return [{ type: 'agentMessage', text, raw: frame }]
  }
  if (t === OPENCODE_FRAME.stepStart) {
    return [{ type: 'turnStarted', raw: frame }]
  }
  if (t === OPENCODE_FRAME.stepFinish) {
    return [{ type: 'turnCompleted', raw: frame }]
  }
  if (t === OPENCODE_FRAME.reasoning) {
    const part = frame.part as OpencodeReasoningPart | undefined
    const text = typeof part?.text === 'string' ? part.text : ''
    if (!text) return []
    return [{ type: 'commentary', text, raw: frame }]
  }
  if (t === OPENCODE_FRAME.toolUse) {
    const part = frame.part as OpencodeToolPart | undefined
    const id = typeof part?.callID === 'string' ? part.callID : ''
    if (!id) return [{ type: 'toolCall', raw: frame }]
    const name = typeof part?.tool === 'string' ? part.tool : 'tool'
    const out: SubagentEvent[] = [
      { type: 'toolCall', raw: { id, name, input: part?.state?.input } },
    ]
    const status = part?.state?.status
    if (status === 'completed' || status === 'error') {
      out.push({ type: 'toolResult', raw: { tool_use_id: id } })
    }
    return out
  }
  return [{ type: t, raw: frame }]
}

/**
 * Parse one stdout line into 1..2 events. Non-JSON lines degrade to a `log`
 * event (defensive — they should not appear with `--format json`, but a
 * stray banner must never abort the run).
 */
export function opencodeLineToEvents(line: string): SubagentEvent[] {
  try {
    const parsed = JSON.parse(line) as OpencodeFrame
    return opencodeFrameToEvents(parsed)
  } catch {
    return [{ type: 'log', text: line, raw: line }]
  }
}

/** Dedupe `agentMessage` events by `part.id` (last write wins), preserving order. */
export function collectOpencodeAnswerParts(
  events: readonly SubagentEvent[],
): string[] {
  const order: string[] = []
  const latest = new Map<string, string>()
  events.forEach((ev, idx) => {
    if (ev.type !== 'agentMessage') return
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

/** The `part` of the last `turnCompleted` (step_finish) event, if any. */
export function lastStepFinishPart(
  events: readonly SubagentEvent[],
): OpencodeStepFinishPart | null {
  let found: OpencodeStepFinishPart | null = null
  for (const ev of events) {
    if (ev.type !== 'turnCompleted') continue
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
