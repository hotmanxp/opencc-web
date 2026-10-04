// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { type ReactNode } from 'react';
import { Box } from '../../../../ink.js';
import { USER_CONFIG_DIRNAME } from '../../../../constants.js';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import { isAutoMemoryEnabled } from '../../../../memdir/paths.js';
import { type AgentMemoryScope, loadAgentMemoryPrompt } from '../../../../tools/AgentTool/agentMemory.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Select } from '../../../CustomSelect/select.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import type { AgentWizardData } from '../types.js';
type MemoryOption = {
  label: string;
  value: AgentMemoryScope | 'none';
};
export function MemoryStep() {
  return null;
}
