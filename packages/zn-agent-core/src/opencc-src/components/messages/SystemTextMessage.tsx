// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { Box, Text, type TextProps } from '../../ink.js';
import * as React from 'react';
import { useState } from 'react';
import sample from 'lodash-es/sample.js';
import { BLACK_CIRCLE, REFERENCE_MARK, TEARDROP_ASTERISK } from '../../constants/figures.js';
import figures from 'figures';
import { basename } from 'path';
import { MessageResponse } from '../MessageResponse.js';
import { FilePathLink } from '../FilePathLink.js';
import { openPath } from '../../utils/browser.js';
/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemSaved = true ? require('./teamMemSaved.js') as typeof import('./teamMemSaved.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
import { TURN_COMPLETION_VERBS } from '../../constants/turnCompletionVerbs.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import type { SystemMessage, SystemStopHookSummaryMessage, SystemBridgeStatusMessage, SystemTurnDurationMessage, SystemThinkingMessage, SystemMemorySavedMessage } from '../../types/message.js';
import { SystemAPIErrorMessage } from './SystemAPIErrorMessage.js';
import { formatDuration, formatNumber, formatSecondsShort } from '../../utils/format.js';
import { getGlobalConfig } from '../../utils/config.js';
import Link from '../../ink/components/Link.js';
import ThemedText from '../design-system/ThemedText.js';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { useAppStateStore } from '../../state/AppState.js';
import { isBackgroundTask, type TaskState } from '../../tasks/types.js';
import { getPillLabel } from '../../tasks/pillLabel.js';
import { useSelectedMessageBg } from '../messageActions.js';
type Props = {
  message: SystemMessage;
  addMargin: boolean;
  verbose: boolean;
  isTranscriptMode?: boolean;
};
export function SystemTextMessage(t0) {
  return null;
}
function StopHookSummaryMessage(t0) {
  return null;
}
function _temp3(info_0, idx_0) {
  const durationStr_0 = false && info_0.durationMs !== undefined ? ` (${formatSecondsShort(info_0.durationMs)})` : "";
  return <Text key={`cmd-${idx_0}`} dimColor={true}>└  {info_0.command === "prompt" ? `prompt: ${info_0.promptText || ""}` : info_0.command}{durationStr_0}</Text>;
}
function _temp2(info, idx) {
  const durationStr = false && info.durationMs !== undefined ? ` (${formatSecondsShort(info.durationMs)})` : "";
  return <Text key={`cmd-${idx}`} dimColor={true}>{"     \u2514 "}{info.command === "prompt" ? `prompt: ${info.promptText || ""}` : info.command}{durationStr}</Text>;
}
function _temp(sum, h) {
  return sum + (h.durationMs ?? 0);
}
function SystemTextMessageInner(t0) {
  return null;
}
function TurnDurationMessage(t0) {
  return null;
}
function _temp4() {
  return sample(TURN_COMPLETION_VERBS) ?? "Worked";
}
function MemorySavedMessage(t0) {
  return null;
}
function _temp5(p) {
  return <MemoryFileRow key={p} path={p} />;
}
function MemoryFileRow(t0) {
  return null;
}
function ThinkingMessage(t0) {
  return null;
}
function BridgeStatusMessage(t0) {
  return null;
}
