import * as React from 'react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
type Props = {
  code: string;
  filePath: string;
  width?: number;
  dim?: boolean;
};
const DEFAULT_WIDTH = 80;
export const HighlightedCode = memo(function HighlightedCode(t0: Props): React.ReactNode | null {
  return null;
});
function CodeLine(t0: {
  line: string;
  gutterWidth: number;
}): React.ReactNode | null {
  return null;
}
