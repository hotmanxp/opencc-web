// @ts-nocheck
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { Text } from '../../ink.js'
import * as React from 'react';
import { useState } from 'react';
import sample from 'lodash-es/sample.js';
import figures from 'figures';
/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemSaved = true ? require('./teamMemSaved.js') as typeof import('./teamMemSaved.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
import { TURN_COMPLETION_VERBS } from '../../constants/turnCompletionVerbs.js';
import type { SystemMessage } from '../../types/message.js'
import { formatSecondsShort } from '../../utils/format.js'
import Link from '../../ink/components/Link.js';
import ThemedText from '../design-system/ThemedText.js';
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
