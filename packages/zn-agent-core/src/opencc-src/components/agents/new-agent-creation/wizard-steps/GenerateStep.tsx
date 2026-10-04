import { APIUserAbortError } from '@anthropic-ai/sdk';
import React, { type ReactNode, useCallback, useRef, useState } from 'react';
import { useMainLoopModel } from '../../../../hooks/useMainLoopModel.js';
import { Box, Text } from '../../../../ink.js';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import { createAbortController } from '../../../../utils/abortController.js';
import { editPromptInEditor } from '../../../../utils/promptEditor.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Byline } from '../../../design-system/Byline.js';
import { Spinner } from '../../../Spinner.js';
import TextInput from '../../../TextInput.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import { generateAgent } from '../../generateAgent.js';
// @ts-ignore
import type { AgentWizardData } from '../types.js';
export function GenerateStep(): ReactNode | null {
  return null;
}
