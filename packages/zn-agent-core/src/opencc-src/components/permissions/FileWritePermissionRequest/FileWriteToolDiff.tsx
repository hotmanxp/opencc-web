// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useMemo } from 'react';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { Box, NoSelect, Text } from '../../../ink.js';
import { intersperse } from '../../../utils/array.js';
import { getPatchForDisplay } from '../../../utils/diff.js';
import { HighlightedCode } from '../../HighlightedCode.js';
import { StructuredDiff } from '../../StructuredDiff.js';
type Props = {
  file_path: string;
  content: string;
  fileExists: boolean;
  oldContent: string;
};
export function FileWriteToolDiff(t0: Props): React.ReactNode | null {
  return null;
}
function _temp(i) {
  return <NoSelect fromLeftEdge={true} key={`ellipsis-${i}`}><Text dimColor={true}>...</Text></NoSelect>;
}
