// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { useCallback, useMemo } from 'react';
import { getOriginalCwd } from '../../bootstrap/state.js';
import { Box, Text, useTheme } from '../../ink.js';
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js';
import { env } from '../../utils/env.js';
import { shouldShowAlwaysAllowOptions } from '../../utils/permissions/permissionsLoader.js';
import { truncateToLines } from '../../utils/stringUtils.js';
import { logUnaryEvent } from '../../utils/unaryLogging.js';
import { type UnaryEvent, usePermissionRequestLogging } from './hooks.js';
import { PermissionDialog } from './PermissionDialog.js';
import { PermissionPrompt, type PermissionPromptOption, type ToolAnalyticsContext } from './PermissionPrompt.js';
import type { PermissionRequestProps } from './PermissionRequest.js';
import { PermissionRuleExplanation } from './PermissionRuleExplanation.js';
type FallbackOptionValue = 'yes' | 'yes-dont-ask-again' | 'no';
export function FallbackPermissionRequest(t0) {
  return null;
}
