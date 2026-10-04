// @ts-nocheck
import * as React from 'react';
import { Suspense, use, useMemo } from 'react';
import { NoSelect, Text } from '../../../ink.js'
import type { NotebookCellType, NotebookContent } from '../../../types/notebook.js';
import { safeParseJSON } from '../../../utils/json.js';
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
