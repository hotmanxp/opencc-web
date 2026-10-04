// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Link, Text } from '../ink.js';
import { updateSettingsForSource } from '../utils/settings/settings.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';

// NOTE: This copy is legally reviewed — do not modify without Legal team approval.
export const AUTO_MODE_DESCRIPTION = "Auto mode lets OpenCC handle permission prompts automatically — OpenCC checks each tool call for risky actions and prompt injection before executing. Actions OpenCC identifies as safe are executed, while actions OpenCC identifies as risky are blocked and OpenCC may try a different approach. Ideal for long-running tasks. Sessions are slightly more expensive. OpenCC can make mistakes that allow harmful commands to run, it's recommended to only use in isolated environments. Shift+Tab to change mode.";
type Props = {
  onAccept(): void;
  onDecline(): void;
  // Startup gate: decline exits the process, so relabel accordingly.
  declineExits?: boolean;
};
export function AutoModeOptInDialog(t0: Props) {
  return null;
}
function _temp() {
  logEvent("tengu_auto_mode_opt_in_dialog_shown", {});
}
