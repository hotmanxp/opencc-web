// @ts-nocheck
import chalk from 'chalk';
import figures from 'figures';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Text } from '../ink.js';
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
