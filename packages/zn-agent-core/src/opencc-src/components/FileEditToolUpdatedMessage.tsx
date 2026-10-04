// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text } from '../ink.js';
import { count } from '../utils/array.js';
import { MessageResponse } from './MessageResponse.js';
import { StructuredDiffList } from './StructuredDiffList.js';
type Props = {
  filePath: string;
  structuredPatch: StructuredPatchHunk[];
  firstLine: string | null;
  fileContent?: string;
  style?: 'condensed';
  verbose: boolean;
  previewHint?: string;
};
export function FileEditToolUpdatedMessage(t0) {
  return null;
}
function _temp4(acc_0, hunk_0) {
  return acc_0 + count(hunk_0.lines, _temp3);
}
function _temp3(__0) {
  return __0.startsWith("-");
}
function _temp2(acc, hunk) {
  return acc + count(hunk.lines, _temp);
}
function _temp(_) {
  return _.startsWith("+");
}
