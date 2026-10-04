// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { useCallback, useState } from 'react';
import { Box, Text } from '../ink.js';
import { getDisplayPath } from '../utils/file.js';
import { removePathFromRepo, validateRepoAtPath } from '../utils/githubRepoPathMapping.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
import { Spinner } from './Spinner.js';
type Props = {
  targetRepo: string;
  initialPaths: string[];
  onSelectPath: (path: string) => void;
  onCancel: () => void;
};
export function TeleportRepoMismatchDialog(t0) {
  return null;
}
function _temp(path) {
  return {
    label: <Text>Use <Text bold={true}>{getDisplayPath(path)}</Text></Text>,
    value: path
  };
}
