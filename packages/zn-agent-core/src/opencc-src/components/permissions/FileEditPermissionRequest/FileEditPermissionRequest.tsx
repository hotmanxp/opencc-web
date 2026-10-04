// @ts-nocheck
import React from 'react';
import type { z } from 'zod/v4';
import { FileEditTool } from '../../../tools/FileEditTool/FileEditTool.js';
import { createSingleEditDiffConfig, type FileEdit, type IDEDiffSupport } from '../FilePermissionDialog/ideDiffConfig.js';
type FileEditInput = z.infer<typeof FileEditTool.inputSchema>;
const ideDiffSupport: IDEDiffSupport<FileEditInput> = {
  getConfig: (input: FileEditInput) => createSingleEditDiffConfig(input.file_path, input.old_string, input.new_string, input.replace_all),
  applyChanges: (input: FileEditInput, modifiedEdits: FileEdit[]) => {
    const firstEdit = modifiedEdits[0];
    if (firstEdit) {
      return {
        ...input,
        old_string: firstEdit.old_string,
        new_string: firstEdit.new_string,
        replace_all: firstEdit.replace_all
      };
    }
    return input;
  }
};
export function FileEditPermissionRequest(props) {
  return null;
}
function _temp(input) {
  return FileEditTool.inputSchema.parse(input);
}
