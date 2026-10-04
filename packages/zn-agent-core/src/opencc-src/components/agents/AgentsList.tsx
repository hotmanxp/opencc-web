import type { SettingSource } from 'src/utils/settings/constants.js';
import type { ResolvedAgent } from '../../tools/AgentTool/agentDisplay.js';
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js';
type Props = {
  source: SettingSource | 'all' | 'built-in' | 'plugin';
  agents: ResolvedAgent[];
  onBack: () => void;
  onSelect: (agent: AgentDefinition) => void;
  onCreateNew?: () => void;
  changes?: string[];
  activeAgentName?: string;
};
export function AgentsList(t0) {
  return null;
}
function _temp1(a_9) {
  return a_9.source === "built-in";
}
function _temp0(a_8) {
  return a_8.source !== "built-in";
}
function _temp9(g_0) {
  return g_0.source !== "built-in";
}
function _temp8(a_6) {
  return !a_6.overriddenBy;
}
function _temp7(a_5) {
  return a_5.source === "built-in";
}
function _temp6(a_4) {
  return a_4.source !== "built-in";
}
function _temp5(a_3) {
  return a_3.source === "built-in";
}
function _temp4(a_2) {
  return a_2.source === "built-in";
}
function _temp3(g) {
  return g.source !== "built-in";
}
function _temp2(a) {
  return a.source !== "built-in";
}
function _temp(agent) {
  return {
    isOverridden: !!agent.overriddenBy,
    overriddenBy: agent.overriddenBy || null
  };
}
