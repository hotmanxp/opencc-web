/**
 * C.2 — Continuation nudge injection (spec C §2.1, §3 行为 3-7).
 *
 * Pure function. **Never throws.** Decides whether to inject a synthetic
 * assistant nudge message that forces the model into another turn, and
 * returns the updated counter state.
 *
 * Counters (loop-local, spec §6.5 — not persisted):
 *   - `consecutive`: contiguous needs-tool injections (resets only when
 *     the model genuinely completes a turn with no needs-tool signal).
 *     We approximate the reset in the function by NOT mutating
 *     consecutive when intent='complete' (the runtime is expected to
 *     reset it externally when a real tool_use lands).
 *   - `total`: monotonic across the whole queryLoop lifetime.
 *
 * Reasons (discriminated by result shape):
 *   - 'complete'            — intent='complete'; no nudge
 *   - 'disabled'            — feature turned off via opts.enabled=false
 *   - 'needs-tool-max'      — consecutive >= max; bail out
 *   - 'needs-tool-injected' — we yielded a nudge; counters incremented
 *
 * The returned `nudgeMessage` is shaped like a `RuntimeEvent` (loose
 * type from `runtime/events.ts` — a tagged record with `type`). The
 * wire-in stage (Phase 2 in queryLoop.ts) is responsible for
 * translating this into whatever stream event format the model and
 * transcript expect; we keep the shape minimal so the unit test can
 * pin the contract.
 */
import type { RuntimeEvent } from '../events.js'
import type { ContinuationIntent } from './analyze.js'

/**
 * Loop-local counters for continuation nudges. Spec §2.1.
 *
 * `consecutive`: contiguous needs-tool injections; reset by the
 *   runtime when intent='complete' is observed for a real model turn
 *   (i.e. via tool_use or message_stop without a marker).
 * `total`: monotonic counter of every inject attempt; useful for
 *   telemetry / debug.
 */
export interface NudgeCounters {
  /** Number of consecutive needs-tool injections. */
  consecutive: number
  /** Total inject attempts across the lifetime of queryLoop. */
  total: number
}

export interface InjectNudgeOptions {
  counters: NudgeCounters
  /** Max consecutive nudges before bailing. Default 20 (spec §3.3). */
  max?: number
  /** Feature toggle. Default true. */
  enabled?: boolean
}

export type InjectNudgeReason =
  | 'complete'
  | 'disabled'
  | 'needs-tool-max'
  | 'needs-tool-injected'

export interface InjectNudgeResult {
  inject: boolean
  reason: InjectNudgeReason
  /** The synthetic message to yield downstream when inject=true. */
  nudgeMessage?: RuntimeEvent
  /** Updated counters (NOT a mutation of the input). */
  counters: NudgeCounters
}

/** Default max nudges per spec §3.3: config.runtime.continuationNudgeMax = 20. */
export const DEFAULT_CONTINUATION_NUDGE_MAX = 20

/**
 * The nudge text we yield as an assistant message. Kept short and
 * language-neutral; the model understands "continue" in any locale.
 *
 * Spec §7 leaves this free; we picked a bilingual short phrase so it
 * reads cleanly in both English and Chinese transcripts.
 */
export const CONTINUATION_NUDGE_TEXT =
  'Continue with the next step. 请继续执行下一步。'

/**
 * Build the nudge RuntimeEvent. We use a synthetic `runtime.delta`
 * with a special `__nudge: true` marker on the payload so the wire-in
 * can recognize and route it correctly (e.g. persist as a transcript
 * assistant message rather than forward to the model's delta stream).
 *
 * We do NOT pre-fill `eventId` / `sessionId` / `turnIndex` / `ts` —
 * the wire-in layer (Phase 2 in queryLoop.ts) is responsible for
 * enriching the event with those fields via wrapWithZaiMeta.
 */
function buildNudgeMessage(counters: NudgeCounters): RuntimeEvent {
  return {
    type: 'runtime.delta',
    payload: {
      text: CONTINUATION_NUDGE_TEXT,
      nudge: true,
      counters: {
        consecutive: counters.consecutive,
        total: counters.total,
      },
    },
  } as unknown as RuntimeEvent
}

/**
 * Decide whether to inject a continuation nudge. Pure; never throws.
 *
 * @param intent  The model's intent, computed by `analyzeContinuationIntent`.
 * @param opts    Loop-local counters + feature toggle.
 */
export function injectContinuationNudge(
  intent: ContinuationIntent,
  opts: InjectNudgeOptions,
): InjectNudgeResult {
  // Defensive defaults — should never fail, but the spec says never throw.
  const max = opts.max ?? DEFAULT_CONTINUATION_NUDGE_MAX
  const enabled = opts.enabled ?? true
  const counters: NudgeCounters = {
    consecutive: opts.counters.consecutive,
    total: opts.counters.total,
  }

  // Rule 1: feature disabled.
  if (!enabled) {
    return {
      inject: false,
      reason: 'disabled',
      counters,
    }
  }

  // Rule 2: model said it was done — no nudge.
  if (intent === 'complete') {
    return {
      inject: false,
      reason: 'complete',
      counters,
    }
  }

  // Rule 3: intent is 'needs-tool' but we're at or past max consecutive
  // nudges. We bail out to avoid infinite loops. Per spec, do NOT
  // increment counters when at max — keep them at the saturation value.
  if (counters.consecutive >= max) {
    return {
      inject: false,
      reason: 'needs-tool-max',
      counters,
    }
  }

  // Rule 4: inject. Increment both counters.
  const next: NudgeCounters = {
    consecutive: counters.consecutive + 1,
    total: counters.total + 1,
  }
  return {
    inject: true,
    reason: 'needs-tool-injected',
    nudgeMessage: buildNudgeMessage(next),
    counters: next,
  }
}