// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import { relative } from 'path';
import * as React from 'react';
import { Suspense, use, useMemo } from 'react';
import { Box, NoSelect, Text } from '../../../ink.js';
import type { NotebookCellType, NotebookContent } from '../../../types/notebook.js';
import { intersperse } from '../../../utils/array.js';
import { getCwd } from '../../../utils/cwd.js';
import { getPatchForDisplay } from '../../../utils/diff.js';
import { getFsImplementation } from '../../../utils/fsOperations.js';
import { safeParseJSON } from '../../../utils/json.js';
import { parseCellId } from '../../../utils/notebook.js';
import { HighlightedCode } from '../../HighlightedCode.js';
import { StructuredDiff } from '../../StructuredDiff.js';
type Props = {
  notebook_path: string;
  cell_id: string | undefined;
  new_source: string;
  cell_type?: NotebookCellType;
  edit_mode?: string;
  verbose: boolean;
  width: number;
};
type InnerProps = {
  notebook_path: string;
  cell_id: string | undefined;
  new_source: string;
  cell_type?: NotebookCellType;
  edit_mode?: string;
  verbose: boolean;
  width: number;
  promise: Promise<NotebookContent | null>;
};
export function NotebookEditToolDiff(props) {
  return null;
}
function _temp2() {
  return null;
}
function _temp(content) {
  return safeParseJSON(content) as NotebookContent | null;
}
function NotebookEditToolDiffInner(t0) {
  return null;
}
function _temp3(i) {
  return <NoSelect fromLeftEdge={true} key={`ellipsis-${i}`}><Text dimColor={true}>...</Text></NoSelect>;
}
