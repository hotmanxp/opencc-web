// @ts-nocheck
import type { CommandResultDisplay } from '../../../commands.js';
import type { ToolPermissionContext } from '../../../Tool.js';
type Props = {
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  toolPermissionContext: ToolPermissionContext;
  onRequestAddDirectory: () => void;
  onRequestRemoveDirectory: (path: string) => void;
  onHeaderFocusChange?: (focused: boolean) => void;
};
type DirectoryItem = {
  path: string;
  isCurrent: boolean;
  isDeletable: boolean;
};
export function WorkspaceTab(t0) {
  return null;
}
function _temp2(dir) {
  return {
    label: dir.path,
    value: dir.path
  };
}
function _temp(path) {
  return {
    path,
    isCurrent: false,
    isDeletable: true
  };
}
