// @ts-nocheck
import React from 'react';
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
