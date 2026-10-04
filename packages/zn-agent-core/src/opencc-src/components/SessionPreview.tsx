// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import type { UUID } from 'crypto';
import React, { useCallback } from 'react';
import { Box, Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { getAllBaseTools } from '../tools.js';
import type { LogOption } from '../types/logs.js';
import { formatRelativeTimeAgo } from '../utils/format.js';
import { getSessionIdFromLog, isLiteLog, loadFullLog } from '../utils/sessionStorage.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Byline } from './design-system/Byline.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { LoadingState } from './design-system/LoadingState.js';
import { Messages } from './Messages.js';
type Props = {
  log: LogOption;
  onExit: () => void;
  onSelect: (log: LogOption) => void;
};
export function SessionPreview(t0) {
  return null;
}
