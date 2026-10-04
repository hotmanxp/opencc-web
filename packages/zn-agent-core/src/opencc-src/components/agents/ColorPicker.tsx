// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import React, { useState } from 'react';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text } from '../../ink.js';
import { AGENT_COLOR_TO_THEME_COLOR, AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js';
import { capitalize } from '../../utils/stringUtils.js';
type ColorOption = AgentColorName | 'automatic';
const COLOR_OPTIONS: ColorOption[] = ['automatic', ...AGENT_COLORS];
type Props = {
  agentName: string;
  currentColor?: AgentColorName | 'automatic';
  onConfirm: (color: AgentColorName | undefined) => void;
};
export function ColorPicker(t0) {
  return null;
}
function _temp2(prev_0) {
  return prev_0 < COLOR_OPTIONS.length - 1 ? prev_0 + 1 : 0;
}
function _temp(prev) {
  return prev > 0 ? prev - 1 : COLOR_OPTIONS.length - 1;
}
