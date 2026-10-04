// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import chalk from 'chalk';
import figures from 'figures';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { toError } from '../utils/errors.js';
import { logError } from '../utils/log.js';
import { getSettingSourceName, type SettingSource } from '../utils/settings/constants.js';
import { updateSettingsForSource } from '../utils/settings/settings.js';
import { getEnvironmentSelectionInfo } from '../utils/teleport/environmentSelection.js';
import type { EnvironmentResource } from '../utils/teleport/environments.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/select.js';
import { Byline } from './design-system/Byline.js';
import { Dialog } from './design-system/Dialog.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { LoadingState } from './design-system/LoadingState.js';
const DIALOG_TITLE = 'Select Remote Environment';
const SETUP_HINT = `Configure environments at: https://claude.ai/code`;
type Props = {
  onDone: (message?: string) => void;
};
type LoadingState = 'loading' | 'updating' | null;
export function RemoteEnvironmentDialog(t0) {
  return null;
}
function EnvironmentLabel(t0) {
  return null;
}
function SingleEnvironmentContent(t0) {
  return null;
}
function MultipleEnvironmentsContent(t0) {
  return null;
}
function _temp(env) {
  return {
    label: <Text>{env.name} <Text dimColor={true}>({env.environment_id})</Text></Text>,
    value: env.environment_id
  };
}
