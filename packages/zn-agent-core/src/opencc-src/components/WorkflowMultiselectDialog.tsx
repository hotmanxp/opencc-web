// @ts-nocheck
import React, { useCallback, useState } from 'react';
import {  } from '../constants/product.js'
import { BRAND_NAME } from '../constants.js';
import type { Workflow } from '../commands/install-github-app/types.js';
import type { ExitState } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Text } from '../ink.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Byline } from './design-system/Byline.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
type WorkflowOption = {
  value: Workflow;
  label: string;
};
type Props = {
  onSubmit: (selectedWorkflows: Workflow[]) => void;
  defaultSelections: Workflow[];
};
const WORKFLOWS: WorkflowOption[] = [{
  value: 'claude' as const,
  label: `@${BRAND_NAME} - Tag @claude in issues and PR comments`
}, {
  value: 'claude-review' as const,
  label: `${BRAND_NAME} Review - Automated code review on new PRs`
}];
function renderInputGuide(exitState: ExitState): React.ReactNode {
  if (exitState.pending) {
    return <Text>Press {exitState.keyName} again to exit</Text>;
  }
  return <Byline>
      <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
      <KeyboardShortcutHint shortcut="Space" action="toggle" />
      <KeyboardShortcutHint shortcut="Enter" action="confirm" />
      <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
    </Byline>;
}
export function WorkflowMultiselectDialog(t0) {
  return null;
}
function _temp(workflow) {
  return {
    label: workflow.label,
    value: workflow.value
  };
}
