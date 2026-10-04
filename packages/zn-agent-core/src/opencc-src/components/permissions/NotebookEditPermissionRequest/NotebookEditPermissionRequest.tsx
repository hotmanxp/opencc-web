// @ts-nocheck
import React from 'react';
import type { z } from 'zod/v4';
import { NotebookEditTool } from '../../../tools/NotebookEditTool/NotebookEditTool.js';
import { logError } from '../../../utils/log.js';
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
