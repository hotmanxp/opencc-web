// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { count } from '../utils/array.js';
import sample from 'lodash-es/sample.js';
import type { Theme } from 'src/utils/theme.js';
import { getSpinnerVerbs } from '../constants/spinnerVerbs.js';
import type { Task } from '../utils/tasks.js';
import { getDefaultCharacters, type SpinnerMode } from './Spinner/index.js';
import { isBackgroundTask, type TaskState } from '../tasks/types.js';
export type { SpinnerMode } from './Spinner/index.js';
const DEFAULT_CHARACTERS = getDefaultCharacters();
const SPINNER_FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];
type Props = {
  mode: SpinnerMode;
  loadingStartTimeRef: React.RefObject<number>;
  totalPausedMsRef: React.RefObject<number>;
  pauseStartTimeRef: React.RefObject<number | null>;
  spinnerTip?: string;
  responseLengthRef: React.RefObject<number>;
  overrideColor?: keyof Theme | null;
  overrideShimmerColor?: keyof Theme | null;
  overrideMessage?: string | null;
  spinnerSuffix?: string | null;
  verbose: boolean;
  hasActiveTools?: boolean;
  /** Leader's turn has completed (no active query). Used to suppress stall-red spinner when only teammates are running. */
  leaderIsIdle?: boolean;
};

// Thin wrapper: branches on isBriefOnly so the two variants have independent
// hook call chains. Without this split, toggling /brief mid-render would
// violate Rules of Hooks (the inner variant calls ~10 more hooks).
export function SpinnerWithVerb(props: Props): React.ReactNode | null {
  return null;
}
function SpinnerWithVerbInner({
  mode,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerTip,
  responseLengthRef,
  overrideColor,
  overrideShimmerColor,
  overrideMessage,
  spinnerSuffix,
  verbose,
  hasActiveTools = false,
  leaderIsIdle = false
}: Props): React.ReactNode | null {
  return null;
}

// Brief/assistant mode spinner: single status line. PromptInput drops its
// own marginTop when isBriefOnly is active, so this component owns the
// 2-row footprint between messages and input. Footprint is [blank, content]
// — one blank row above (breathing room under the messages list), spinner
// flush against the input bar. PromptInput's absolute-positioned
// Notifications overlay compensates with marginTop=-2 in brief mode
// (PromptInput.tsx:~2928) so it floats into the blank row above the
// spinner, not over the spinner content. Paired with BriefIdleStatus which
// keeps the same footprint when idle.
type BriefSpinnerProps = {
  mode: SpinnerMode;
  overrideMessage?: string | null;
};
function BriefSpinner(t0) {
  return null;
}

// Idle placeholder for brief mode. Same 2-row [blank, content] footprint
// as BriefSpinner so the input bar never jumps when toggling between
// working/idle/disconnected. See BriefSpinner's comment for the
// Notifications overlay coupling.
function _temp6(s_0: { tasks: { [k: string]: TaskState }; remoteBackgroundTaskCount: number }): number {
  return count(Object.values(s_0.tasks), isBackgroundTask) + s_0.remoteBackgroundTaskCount;
}
function _temp5(s) {
  return s.remoteConnectionStatus;
}
function _temp4() {
  return sample(getSpinnerVerbs()) ?? "Working";
}
export function BriefIdleStatus() {
  return null;
}
function _temp8(s_0: { tasks: { [k: string]: TaskState }; remoteBackgroundTaskCount: number }): number {
  return count(Object.values(s_0.tasks), isBackgroundTask) + s_0.remoteBackgroundTaskCount;
}
function _temp7(s) {
  return s.remoteConnectionStatus;
}
export function Spinner() {
  return null;
}
function findNextPendingTask(tasks: Task[] | undefined): Task | undefined {
  if (!tasks) {
    return undefined;
  }
  const pendingTasks = tasks.filter(t => t.status === 'pending');
  if (pendingTasks.length === 0) {
    return undefined;
  }
  const unresolvedIds = new Set(tasks.filter(t => t.status !== 'completed').map(t => t.id));
  return pendingTasks.find(t => !t.blockedBy.some(id => unresolvedIds.has(id))) ?? pendingTasks[0];
}
