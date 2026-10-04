// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { Box, Text, useTheme } from '../../../ink.js';
import { FallbackPermissionRequest } from '../FallbackPermissionRequest.js';
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js';
import type { ToolInput } from '../FilePermissionDialog/useFilePermissionDialog.js';
import type { PermissionRequestProps, ToolUseConfirm } from '../PermissionRequest.js';
function pathFromToolUse(toolUseConfirm: ToolUseConfirm): string | null {
  const tool = toolUseConfirm.tool;
  if ('getPath' in tool && typeof tool.getPath === 'function') {
    try {
      return tool.getPath(toolUseConfirm.input);
    } catch {
      return null;
    }
  }
  return null;
}
export function FilesystemPermissionRequest(t0) {
  return null;
}
function _temp(input) {
  return input as ToolInput;
}
