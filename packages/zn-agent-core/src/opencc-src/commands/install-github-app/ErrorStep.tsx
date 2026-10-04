// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { GITHUB_ACTION_SETUP_DOCS_URL } from '../../constants/github-app.js';
import { Box, Text } from '../../ink.js';
interface ErrorStepProps {
  error: string | undefined;
  errorReason?: string;
  errorInstructions?: string[];
}
export function ErrorStep(t0) {
  return null;
}
function _temp(instruction, index) {
  return <Box key={index} marginLeft={2}><Text dimColor={true}>• </Text><Text>{instruction}</Text></Box>;
}
