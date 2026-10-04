// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import partition from 'lodash-es/partition.js';
import React, { useCallback } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Text } from '../ink.js';
import { getSettings_DEPRECATED, updateSettingsForSource } from '../utils/settings/settings.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { SelectMulti } from './CustomSelect/SelectMulti.js';
import { Byline } from './design-system/Byline.js';
import { Dialog } from './design-system/Dialog.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { MCPServerDialogCopy } from './MCPServerDialogCopy.js';
type Props = {
  serverNames: string[];
  onDone(): void;
};
export function MCPServerMultiselectDialog(t0) {
  return null;
}
function _temp(server_0) {
  return {
    label: server_0,
    value: server_0
  };
}
