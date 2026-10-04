// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import { basename, relative } from 'path';
import React, { Suspense, use, useMemo } from 'react';
import { FileEditToolDiff } from 'src/components/FileEditToolDiff.js';
import { getCwd } from 'src/utils/cwd.js';
import { isENOENT } from 'src/utils/errors.js';
import { detectEncodingForResolvedPath } from 'src/utils/fileRead.js';
import { getFsImplementation } from 'src/utils/fsOperations.js';
import { Text } from '../../../ink.js';
import { BashTool } from '../../../tools/BashTool/BashTool.js';
import { applySedSubstitution, type SedEditInfo } from '../../../tools/BashTool/sedEditParser.js';
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
type SedEditPermissionRequestProps = PermissionRequestProps & {
  sedInfo: SedEditInfo;
};
type FileReadResult = {
  oldContent: string;
  fileExists: boolean;
};
export function SedEditPermissionRequest(t0) {
  return null;
}
function _temp(e) {
  if (!isENOENT(e)) {
    throw e;
  }
  return {
    oldContent: "",
    fileExists: false
  };
}
function SedEditPermissionRequestInner(t0) {
  return null;
}
