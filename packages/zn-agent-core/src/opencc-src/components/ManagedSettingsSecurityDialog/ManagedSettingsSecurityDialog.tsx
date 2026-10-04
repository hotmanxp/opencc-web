// @ts-nocheck
import React from 'react';
import {  } from '../../constants/product.js'
import { Box, Text } from '../../ink.js';
import type { SettingsJson } from '../../utils/settings/types.js';
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
