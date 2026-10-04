// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { BLACK_CIRCLE } from '../constants/figures.js';
import { Box, Text } from '../ink.js';
import type { Screen } from '../screens/REPL.js';
import type { NormalizedUserMessage } from '../types/message.js';
import { getUserMessageText } from '../utils/messages.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { MessageResponse } from './MessageResponse.js';
type Props = {
  message: NormalizedUserMessage;
  screen: Screen;
};
export function CompactSummary(t0) {
  return null;
}
