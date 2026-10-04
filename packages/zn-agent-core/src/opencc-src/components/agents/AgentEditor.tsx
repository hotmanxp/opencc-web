import chalk from 'chalk';
import figures from 'figures';
import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import type { Tools } from '../../Tool.js';
import { type AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import { type AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
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
