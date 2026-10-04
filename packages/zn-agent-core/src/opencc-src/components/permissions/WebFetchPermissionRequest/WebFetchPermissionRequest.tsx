// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { useMemo } from 'react';
import { Box, Text, useTheme } from '../../../ink.js';
import { WebFetchTool } from '../../../tools/WebFetchTool/WebFetchTool.js';
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js';
import { type OptionWithDescription, Select } from '../../CustomSelect/select.js';
import { type UnaryEvent, usePermissionRequestLogging } from '../hooks.js';
import { PermissionDialog } from '../PermissionDialog.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js';
import { logUnaryPermissionEvent } from '../utils.js';
function inputToPermissionRuleContent(input: {
  [k: string]: unknown;
}): string {
  try {
    const parsedInput = WebFetchTool.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      return `input:${input.toString()}`;
    }
    const {
      url
    } = parsedInput.data;
    const hostname = new URL(url).hostname;
    return `domain:${hostname}`;
  } catch {
    return `input:${input.toString()}`;
  }
}
export function WebFetchPermissionRequest(t0) {
  return null;
}
