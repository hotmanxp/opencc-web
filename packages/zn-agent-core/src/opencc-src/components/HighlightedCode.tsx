// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useSettings } from '../hooks/useSettings.js';
import { Ansi, Box, type DOMElement, measureElement, NoSelect, Text, useTheme } from '../ink.js';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import sliceAnsi from '../utils/sliceAnsi.js';
import { countCharInString } from '../utils/stringUtils.js';
import { HighlightedCodeFallback } from './HighlightedCode/Fallback.js';
import { expectColorFile } from './StructuredDiff/colorDiff.js';
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
