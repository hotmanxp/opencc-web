// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- 'r' is a view-specific key, not a global keybinding
import { Box, Text, useInput } from '../../../ink.js';
import { type AutoModeDenial, getAutoModeDenials } from '../../../utils/autoModeDenials.js';
import { Select } from '../../CustomSelect/select.js';
import { StatusIcon } from '../../design-system/StatusIcon.js';
import { useTabHeaderFocus } from '../../design-system/Tabs.js';
type Props = {
  onHeaderFocusChange?: (focused: boolean) => void;
  /** Called when approved/retry state changes so parent can act on exit */
  onStateChange: (state: {
    approved: Set<number>;
    retry: Set<number>;
    denials: readonly AutoModeDenial[];
  }) => void;
};
export function RecentDenialsTab(t0) {
  return null;
}
function _temp3() {
  return new Set();
}
function _temp2() {
  return new Set();
}
function _temp() {
  return getAutoModeDenials();
}
