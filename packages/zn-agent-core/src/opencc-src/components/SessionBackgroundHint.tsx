// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useCallback, useState } from 'react';
import { useDoublePress } from '../hooks/useDoublePress.js';
import { Box, Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js';
import { backgroundAll, hasForegroundTasks } from '../tasks/LocalShellTask/LocalShellTask.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import { env } from '../utils/env.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
type Props = {
  onBackgroundSession: () => void;
  isLoading: boolean;
};

/**
 * Shows a hint when user presses Ctrl+B to background the current session.
 * Uses double-press pattern: first press shows hint, second press within 800ms backgrounds.
 *
 * Only activates when:
 * 1. isLoading is true (a query is in progress)
 * 2. No foreground tasks (bash/agent) are running (those take priority for Ctrl+B)
 */
export function SessionBackgroundHint(t0) {
  return null;
}
function _temp2(c) {
  return c.hasUsedBackgroundTask ? c : {
    ...c,
    hasUsedBackgroundTask: true
  };
}
function _temp() {}
