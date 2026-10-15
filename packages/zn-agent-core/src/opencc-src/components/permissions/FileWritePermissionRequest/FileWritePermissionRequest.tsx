import React, { useMemo } from 'react';
import type { z } from 'zod/v4';
import { FileWriteTool } from '../../../tools/FileWriteTool/FileWriteTool.js';
import { isENOENT } from '../../../utils/errors.js';
import { readFileSync } from '../../../utils/fileRead.js';
import { createSingleEditDiffConfig, type FileEdit, type IDEDiffSupport } from '../FilePermissionDialog/ideDiffConfig.js';
type FileWriteToolInput = z.infer<typeof FileWriteTool.inputSchema>;
const ideDiffSupport: IDEDiffSupport<FileWriteToolInput> = {
  getConfig: (input: FileWriteToolInput) => {
    let oldContent: string;
    try {
      oldContent = readFileSync(input.file_path);
    } catch (e) {
      if (!isENOENT(e)) throw e;
      oldContent = '';
    }
    return createSingleEditDiffConfig(input.file_path, oldContent, input.content, false // For file writes, we replace the entire content
    );
  },
  applyChanges: (input: FileWriteToolInput, modifiedEdits: FileEdit[]) => {
    const firstEdit = modifiedEdits[0];
    if (firstEdit) {
      return {
        ...input,
        content: firstEdit.new_string
      };
    }
    return input;
  }
};
export function FileWritePermissionRequest(props) {
  return null;
}
function _temp(input) {
  return FileWriteTool.inputSchema.parse(input);
}
