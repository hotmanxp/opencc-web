// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import React from 'react';
import { GITHUB_ACTION_SETUP_DOCS_URL } from '../../constants/github-app.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { Warning } from './types.js';
interface WarningsStepProps {
  warnings: Warning[];
  onContinue: () => void;
}
export function WarningsStep(t0) {
  return null;
}
function _temp2(warning, index) {
  return <Box key={index} flexDirection="column" marginBottom={1}><Text color="warning" bold={true}>{warning.title}</Text><Text>{warning.message}</Text>{warning.instructions.length > 0 && <Box flexDirection="column" marginLeft={2} marginTop={1}>{warning.instructions.map(_temp)}</Box>}</Box>;
}
function _temp(instruction, i) {
  return <Text key={i} dimColor={true}>• {instruction}</Text>;
}
