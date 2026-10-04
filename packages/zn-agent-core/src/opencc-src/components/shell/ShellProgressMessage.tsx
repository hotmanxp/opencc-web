// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { stripVTControlCharacters as stripAnsi } from 'node:util';
import { Box, Text } from '../../ink.js';
import { formatFileSize } from '../../utils/format.js';
import { MessageResponse } from '../MessageResponse.js';
import { OffscreenFreeze } from '../OffscreenFreeze.js';
import { ShellTimeDisplay } from './ShellTimeDisplay.js';
type Props = {
  output: string;
  fullOutput: string;
  elapsedTimeSeconds?: number;
  totalLines?: number;
  totalBytes?: number;
  timeoutMs?: number;
  taskId?: string;
  verbose: boolean;
};
export function ShellProgressMessage(t0) {
  return null;
}
function _temp(line) {
  return line;
}
