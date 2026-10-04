// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { useCallback, useEffect } from 'react';
import { getOriginalCwd } from '../../../bootstrap/state.js';
import type { CommandResultDisplay } from '../../../commands.js';
import { Select } from '../../../components/CustomSelect/select.js';
import { Box, Text } from '../../../ink.js';
import type { ToolPermissionContext } from '../../../Tool.js';
import { useTabHeaderFocus } from '../../design-system/Tabs.js';
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
