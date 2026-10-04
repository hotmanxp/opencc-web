// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { type ReactNode, useCallback, useMemo, useState } from 'react';
import { Box, Text } from '../../ink.js';
import type { KeybindingAction } from '../../keybindings/types.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { useSetAppState } from '../../state/AppState.js';
import { type OptionWithDescription, Select } from '../CustomSelect/select.js';
export type FeedbackType = 'accept' | 'reject';
export type PermissionPromptOption<T extends string> = {
  value: T;
  label: ReactNode;
  feedbackConfig?: {
    type: FeedbackType;
    placeholder?: string;
  };
  keybinding?: KeybindingAction;
};
export type ToolAnalyticsContext = {
  toolName: string;
  isMcp: boolean;
};
export type PermissionPromptProps<T extends string> = {
  options: PermissionPromptOption<T>[];
  onSelect: (value: T, feedback?: string) => void;
  onCancel?: () => void;
  question?: string | ReactNode;
  toolAnalyticsContext?: ToolAnalyticsContext;
};
const DEFAULT_PLACEHOLDERS: Record<FeedbackType, string> = {
  accept: 'tell OpenCC what to do next',
  reject: 'tell OpenCC what to do differently'
};

/**
 * Shared component for permission prompts with optional feedback input.
 *
 * Handles:
 * - "Do you want to proceed?" question with optional Tab hint
 * - Feature flag check for feedback capability
 * - Input mode toggling (Tab to expand feedback input)
 * - Analytics events for feedback interactions
 * - Transforming options to Select-compatible format
 */
export function PermissionPrompt(t0) {
  return null;
}
function _temp(prev) {
  return {
    ...prev,
    attribution: {
      ...prev.attribution,
      escapeCount: prev.attribution.escapeCount + 1
    }
  };
}
