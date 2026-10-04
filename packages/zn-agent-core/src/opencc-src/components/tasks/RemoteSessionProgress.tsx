// @ts-nocheck
import { useRef } from 'react'
import type { RemoteAgentTaskState } from 'src/tasks/RemoteAgentTask/RemoteAgentTask.js';
const TICK_MS = 80;
type ReviewStage = NonNullable<NonNullable<RemoteAgentTaskState['reviewProgress']>['stage']>;

/**
 * Stage-appropriate counts line for a running review. Shared between the
 * one-line pill (below) and RemoteSessionDetailDialog's reviewCountsLine so
 * the two can't drift — they have historically disagreed on whether to show
 * refuted counts and what to call the synthesizing stage.
 *
 * Canonical behavior: word labels (not ✓/✗), hide refuted when 0, "deduping"
 * for the synthesizing stage (matches STAGE_LABELS in the detail dialog).
 */
export function formatReviewStageCounts(stage: ReviewStage | undefined, found: number, verified: number, refuted: number): string {
  // Pre-stage orchestrator images don't write the stage field.
  if (!stage) return `${found} found · ${verified} verified`;
  if (stage === 'synthesizing') {
    const parts = [`${verified} verified`];
    if (refuted > 0) parts.push(`${refuted} refuted`);
    parts.push('deduping');
    return parts.join(' · ');
  }
  if (stage === 'verifying') {
    const parts = [`${found} found`, `${verified} verified`];
    if (refuted > 0) parts.push(`${refuted} refuted`);
    return parts.join(' · ');
  }
  // stage === 'finding'
  return found > 0 ? `${found} found` : 'finding';
}

// Per-character rainbow gradient, same treatment as the ultraplan keyword.
// The phase offset lets the gradient cycle — so the colors sweep along the
// text on each animation frame instead of being static.
function RainbowText(t0) {
  return null;
}

// Smooth-tick a count toward target, +1 per frame. Same pattern as the
// token counter in SpinnerAnimationRow — the ref survives re-renders and
// the animation clock drives the tick. Target jumps (2→5) display as
// 2→3→4→5 instead of snapping. When `snap` is set (reduced motion, or
// the clock is frozen), bypass the tick and jump straight to target —
// otherwise a frozen `time` would leave the ref stuck at its init value.
function useSmoothCount(target: number, time: number, snap: boolean): number {
  const displayed = useRef(target);
  const lastTick = useRef(time);
  if (snap || target < displayed.current) {
    displayed.current = target;
  } else if (target > displayed.current && time !== lastTick.current) {
    displayed.current += 1;
    lastTick.current = time;
  }
  return displayed.current;
}
function ReviewRainbowLine(t0) {
  return null;
}
export function RemoteSessionProgress(t0) {
  return null;
}
function _temp(_) {
  return _.status === "completed";
}
