// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../ink.js';
import { useAppState } from '../state/AppState.js';
import { getViewedTeammateTask } from '../state/selectors.js';
import { toInkColor } from '../utils/ink.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { OffscreenFreeze } from './OffscreenFreeze.js';

/**
 * Header shown when viewing a teammate's transcript.
 * Displays teammate name (colored), task description, and exit hint.
 */
export function TeammateViewHeader() {
  return null;
}
function _temp(s) {
  return getViewedTeammateTask(s);
}
