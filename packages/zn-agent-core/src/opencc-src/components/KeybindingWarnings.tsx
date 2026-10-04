// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { Box, Text } from '../ink.js';
import { getCachedKeybindingWarnings, getKeybindingsPath, isKeybindingCustomizationEnabled } from '../keybindings/loadUserBindings.js';

/**
 * Displays keybinding validation warnings in the UI.
 * Similar to McpParsingWarnings, this provides persistent visibility
 * of configuration issues.
 *
 * Only shown when keybinding customization is enabled (ant users + feature gate).
 */
export function KeybindingWarnings() {
  return null;
}
function _temp4(warning, i_0) {
  return <Box key={`warning-${i_0}`} flexDirection="column"><Box><Text dimColor={true}>└ </Text><Text color="warning">[Warning]</Text><Text dimColor={true}> {warning.message}</Text></Box>{warning.suggestion && <Box marginLeft={3}><Text dimColor={true}>→ {warning.suggestion}</Text></Box>}</Box>;
}
function _temp3(error, i) {
  return <Box key={`error-${i}`} flexDirection="column"><Box><Text dimColor={true}>└ </Text><Text color="error">[Error]</Text><Text dimColor={true}> {error.message}</Text></Box>{error.suggestion && <Box marginLeft={3}><Text dimColor={true}>→ {error.suggestion}</Text></Box>}</Box>;
}
function _temp2(w_0) {
  return w_0.severity === "warning";
}
function _temp(w) {
  return w.severity === "error";
}
