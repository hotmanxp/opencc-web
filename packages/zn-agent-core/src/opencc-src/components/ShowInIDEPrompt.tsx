// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import { basename, relative } from 'path';
import React from 'react';
import { Box, Text } from '../ink.js';
import { getCwd } from '../utils/cwd.js';
import { isSupportedVSCodeTerminal } from '../utils/ide.js';
import { Select } from './CustomSelect/index.js';
import { Pane } from './design-system/Pane.js';
import type { PermissionOption, PermissionOptionWithLabel } from './permissions/FilePermissionDialog/permissionOptions.js';
type Props<A> = {
  filePath: string;
  input: A;
  onChange: (option: PermissionOption, args: A, feedback?: string) => void;
  options: PermissionOptionWithLabel[];
  ideName: string;
  symlinkTarget?: string | null;
  rejectFeedback: string;
  acceptFeedback: string;
  setFocusedOption: (value: string) => void;
  onInputModeToggle: (value: string) => void;
  focusedOption: string;
  yesInputMode: boolean;
  noInputMode: boolean;
};
export function ShowInIDEPrompt(t0) {
  return null;
}
