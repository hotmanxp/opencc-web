import * as React from 'react';
import { useMemo } from 'react';
import { NoSelect, Text } from '../../../ink.js'
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
