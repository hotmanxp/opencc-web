import chalk from 'chalk';
import figures from 'figures';
import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { useSetAppState } from 'src/state/AppState.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { Tools } from '../../Tool.js';
import { type AgentColorName, setAgentColor } from '../../tools/AgentTool/agentColorManager.js';
import { type AgentDefinition, getActiveAgentsFromList, isCustomAgent, isPluginAgent } from '../../tools/AgentTool/loadAgentsDir.js';
import { editFileInEditor } from '../../utils/promptEditor.js';
import { getActualAgentFilePath, updateAgentFile } from './agentFileUtils.js';
import { ColorPicker } from './ColorPicker.js';
import { ModelSelector } from './ModelSelector.js';
import { ToolSelector } from './ToolSelector.js';
import { getAgentSourceDisplayName } from './utils.js';
type Props = {
  agent: AgentDefinition;
  tools: Tools;
  onSaved: (message: string) => void;
  onBack: () => void;
};
type EditMode = 'menu' | 'edit-tools' | 'edit-color' | 'edit-model';
type SaveChanges = {
  tools?: string[];
  color?: AgentColorName;
  model?: string;
};
export function AgentEditor({
  agent,
  tools,
  onSaved,
  onBack
}: Props): React.ReactNode | null {
  return null;
}
