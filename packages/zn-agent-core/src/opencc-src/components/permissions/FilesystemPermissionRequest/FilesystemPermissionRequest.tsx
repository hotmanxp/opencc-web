// @ts-nocheck
import type { ToolInput } from '../FilePermissionDialog/useFilePermissionDialog.js';
import type { ToolUseConfirm } from '../PermissionRequest.js'
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
