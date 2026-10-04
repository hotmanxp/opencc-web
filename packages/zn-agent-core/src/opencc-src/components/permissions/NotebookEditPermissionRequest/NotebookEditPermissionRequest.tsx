// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import { basename } from 'path';
import React from 'react';
import type { z } from 'zod/v4';
import { Text } from '../../../ink.js';
import { NotebookEditTool } from '../../../tools/NotebookEditTool/NotebookEditTool.js';
import { logError } from '../../../utils/log.js';
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { NotebookEditToolDiff } from './NotebookEditToolDiff.js';
type NotebookEditInput = z.infer<typeof NotebookEditTool.inputSchema>;
export function NotebookEditPermissionRequest(props) {
  return null;
}
function _temp(input) {
  const result = NotebookEditTool.inputSchema.safeParse(input);
  if (!result.success) {
    logError(new Error(`Failed to parse notebook edit input: ${result.error.message}`));
    return {
      notebook_path: "",
      new_source: "",
      cell_id: ""
    } as NotebookEditInput;
  }
  return result.data;
}
