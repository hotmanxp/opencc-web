// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useMemo } from 'react';
import { type Command, formatDescriptionWithSource } from '../../commands.js';
import { Box, Text } from '../../ink.js';
import { truncate } from '../../utils/format.js';
import { Select } from '../CustomSelect/select.js';
import { useTabHeaderFocus } from '../design-system/Tabs.js';
type Props = {
  commands: Command[];
  maxHeight: number;
  columns: number;
  title: string;
  onCancel: () => void;
  emptyMessage?: string;
};
export function Commands(t0) {
  return null;
}
function _temp(a, b) {
  return a.name.localeCompare(b.name);
}
