import React, { type ReactNode } from 'react';
import type { Tools } from '../../../Tool.js';
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js';
type Props = {
  tools: Tools;
  existingAgents: AgentDefinition[];
  onComplete: (message: string) => void;
  onCancel: () => void;
};
export function CreateAgentWizard(t0: Props): React.ReactNode | null {
  return null;
}
function _temp() {}
