import { type ReactNode } from 'react'
import type { Tools } from '../../../../Tool.js';
import type { AgentDefinition } from '../../../../tools/AgentTool/loadAgentsDir.js';
type Props = {
  tools: Tools;
  existingAgents: AgentDefinition[];
  onComplete: (message: string) => void;
};
export function ConfirmStepWrapper({
  tools,
  existingAgents,
  onComplete
}: Props): ReactNode | null {
  return null;
}
