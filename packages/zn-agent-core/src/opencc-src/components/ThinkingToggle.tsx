// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useState } from 'react';
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/index.js';
import { Byline } from './design-system/Byline.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { Pane } from './design-system/Pane.js';
export type Props = {
  currentValue: boolean;
  onSelect: (enabled: boolean) => void;
  onCancel?: () => void;
  isMidConversation?: boolean;
};
export function ThinkingToggle(t0) {
  return null;
}
function _temp() {}
