import React, { useCallback, useState } from 'react';
import { Text } from '../ink.js'
import { getDisplayPath } from '../utils/file.js';
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
