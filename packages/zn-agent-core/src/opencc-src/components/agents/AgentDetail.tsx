import type { Tools } from '../../Tool.js';
import { type AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
type Props = {
  agent: AgentDefinition;
  tools: Tools;
  allAgents?: AgentDefinition[];
  onBack: () => void;
  /** Notifies the parent when the route picker opens/closes so an enclosing
   *  Dialog can deactivate its own Esc handler while the picker owns Esc. */
  onRoutingChange?: (routing: boolean) => void;
};
export function AgentDetail(t0) {
  return null;
}
