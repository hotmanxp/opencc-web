// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { type ReactNode, useState } from 'react';
import { Box, Text } from '../../../../ink.js';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import type { AgentDefinition } from '../../../../tools/AgentTool/loadAgentsDir.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import TextInput from '../../../TextInput.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import { validateAgentType } from '../../validateAgent.js';
import type { AgentWizardData } from '../types.js';
type Props = {
  existingAgents: AgentDefinition[];
};
export function TypeStep(_props: Props): React.ReactNode | null {
  return null;
}
