// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useCallback } from 'react';
import { Select } from '../../../components/CustomSelect/select.js';
import { Box, Text } from '../../../ink.js';
import type { ToolPermissionContext } from '../../../Tool.js';
import { applyPermissionUpdate } from '../../../utils/permissions/PermissionUpdate.js';
import { Dialog } from '../../design-system/Dialog.js';
type Props = {
  directoryPath: string;
  onRemove: () => void;
  onCancel: () => void;
  permissionContext: ToolPermissionContext;
  setPermissionContext: (context: ToolPermissionContext) => void;
};
export function RemoveWorkspaceDirectory(t0) {
  return null;
}
