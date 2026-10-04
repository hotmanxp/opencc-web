// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { PromptRequest } from '../../types/hooks.js';
import { Select } from '../CustomSelect/select.js';
import { PermissionDialog } from '../permissions/PermissionDialog.js';
type Props = {
  title: string;
  toolInputSummary?: string | null;
  request: PromptRequest;
  onRespond: (key: string) => void;
  onAbort: () => void;
};
export function PromptDialog(t0) {
  return null;
}
function _temp(opt) {
  return {
    label: opt.label,
    value: opt.key,
    description: opt.description
  };
}
