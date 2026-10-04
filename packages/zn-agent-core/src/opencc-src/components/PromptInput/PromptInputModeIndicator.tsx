// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { Box, Text } from 'src/ink.js';
import { AGENT_COLOR_TO_THEME_COLOR, AGENT_COLORS, type AgentColorName } from 'src/tools/AgentTool/agentColorManager.js';
import type { PromptInputMode } from 'src/types/textInputTypes.js';
import { getTeammateColor } from 'src/utils/teammate.js';
import type { Theme } from 'src/utils/theme.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
type Props = {
  mode: PromptInputMode;
  isLoading: boolean;
  viewingAgentName?: string;
  viewingAgentColor?: AgentColorName;
};

/**
 * Gets the theme color key for the teammate's assigned color.
 * Returns undefined if not a teammate or if the color is invalid.
 */
function getTeammateThemeColor(): keyof Theme | undefined {
  if (!isAgentSwarmsEnabled()) {
    return undefined;
  }
  const colorName = getTeammateColor();
  if (!colorName) {
    return undefined;
  }
  if (AGENT_COLORS.includes(colorName as AgentColorName)) {
    return AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName];
  }
  return undefined;
}
type PromptCharProps = {
  isLoading: boolean;
  // Dead code elimination: parameter named themeColor to avoid "teammate" string in external builds
  themeColor?: keyof Theme;
};

/**
 * Renders the prompt character (❯).
 * Teammate color overrides the default color when set.
 */
function PromptChar(t0) {
  return null;
}
export function PromptInputModeIndicator(t0) {
  return null;
}
