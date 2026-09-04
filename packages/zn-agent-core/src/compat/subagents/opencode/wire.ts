/**
 * opencode `--format json` wire types + spawn argv construction.
 *
 * The opencode CLI (v1.3.13) headless `run` command emits newline-delimited
 * JSON events on stdout. A real tool-using run (captured 2026-09-04) emits
 * four frame kinds — `step_start`, `tool_use`, `text`, `step_finish` — each
 * carrying `sessionID`, `timestamp`, and a `part` object. `step_finish`
 * carries the terminal facts (`part.reason`, `part.tokens`, `part.cost`);
 * intermediate steps finish with `reason: 'tool-calls'`, the terminal one
 * with `reason: 'stop'`. Frame vocabulary beyond these is unverified, so
 * unknown frame types pass through with `raw` fidelity rather than being
 * dropped, and non-JSON lines degrade to `log` events (never fatal).
 */

/** The output flavor this provider always requests. */
export const OPENCODE_FORMAT = 'json'

/** Frame `type` discriminants the provider maps onto SubagentEvent kinds. */
export const OPENCODE_FRAME = {
  stepStart: 'step_start',
  toolUse: 'tool_use',
  reasoning: 'reasoning',
  text: 'text',
  stepFinish: 'step_finish',
} as const

export type OpencodeFrameType =
  (typeof OPENCODE_FRAME)[keyof typeof OPENCODE_FRAME]

/**
 * `step_finish.part.reason` vocabulary. Only `stop` is smoke-confirmed; the
 * rest are defensive best-effort buckets so a run that ends abnormally still
 * maps to a non-`completed` SubagentStopReason instead of silently reading as
 * success. Any unseen value falls back to `unknown`.
 */
export type OpencodeFinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'error'
  | 'abort'
  | (string & {})

/** A `text` frame part: the assistant text block (final answer carriers). */
export interface OpencodeTextPart {
  type: 'text'
  id?: string
  text?: string
  time?: { start?: number; end?: number }
  [k: string]: unknown
}

/**
 * A `tool_use` frame part (smoke-captured 2026-09-04): the tool call and its
 * settled state in ONE frame — `state.input` is the call args, `state.output`
 * the result text, `state.status` the terminal marker (`completed` / `error`;
 * an in-flight `running` shape is defensive-only).
 */
export interface OpencodeToolPart {
  type: 'tool'
  id?: string
  callID?: string
  tool?: string
  state?: {
    status?: string
    input?: unknown
    output?: unknown
    title?: string
    [k: string]: unknown
  }
  [k: string]: unknown
}

/** A `reasoning` frame part: model thinking text (defensive mapping). */
export interface OpencodeReasoningPart {
  type?: 'reasoning'
  id?: string
  text?: string
  [k: string]: unknown
}

/** A `step_finish` frame part: terminal facts for the step. */
export interface OpencodeStepFinishPart {
  type?: string
  reason?: OpencodeFinishReason
  tokens?: Record<string, unknown>
  cost?: number
  [k: string]: unknown
}

/**
 * One raw frame emitted by `opencode run --format json`. Loosely projected —
 * upstream adds fields across patch versions, so a strict shape would block
 * us from upgrading.
 */
export interface OpencodeFrame {
  type?: string
  sessionID?: string
  timestamp?: number
  part?:
    | OpencodeTextPart
    | OpencodeToolPart
    | OpencodeReasoningPart
    | OpencodeStepFinishPart
    | Record<string, unknown>
  [k: string]: unknown
}

/** Args shape for spawning a one-shot `opencode run`. */
export interface OpencodeSpawnArgs {
  /** Required: the prompt text. */
  prompt: string
  /** Optional model id (`provider/model`) override. */
  model?: string
}
