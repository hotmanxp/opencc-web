// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React from 'react';
import {  } from '../../constants/product.js'
import { BRAND_NAME } from '../../constants.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { SettingsJson } from '../../utils/settings/types.js';
import { Select } from '../CustomSelect/index.js';
import { PermissionDialog } from '../permissions/PermissionDialog.js';
import { extractDangerousSettings, formatDangerousSettingsList } from './utils.js';
type Props = {
  settings: SettingsJson;
  onAccept: () => void;
  onReject: () => void;
};
export function ManagedSettingsSecurityDialog(t0) {
  return null;
}
function _temp(item, index) {
  return <Box key={index} paddingLeft={2}><Text><Text dimColor={true}>· </Text><Text>{item}</Text></Text></Box>;
}
