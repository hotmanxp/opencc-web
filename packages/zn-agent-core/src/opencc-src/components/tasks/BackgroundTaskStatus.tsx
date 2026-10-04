// @ts-nocheck
import { stringWidth } from 'src/ink/stringWidth.js';
import { isPanelAgentTask } from 'src/tasks/LocalAgentTask/LocalAgentTask.js';
import { isBackgroundTask } from 'src/tasks/types.js'
import { AGENT_COLOR_TO_THEME_COLOR, AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js';
import type { Theme } from '../../utils/theme.js';
type Props = {
  tasksSelected: boolean;
  isViewingTeammate?: boolean;
  teammateFooterIndex?: number;
  isLeaderIdle?: boolean;
  onOpenDialog?: (taskId?: string) => void;
};
export function BackgroundTaskStatus(t0) {
  return null;
}
function _temp1(pill_0, i_0) {
  const pillText = `@${pill_0.name}`;
  return stringWidth(pillText) + (i_0 > 0 ? 1 : 0);
}
function _temp0(pill, i) {
  return {
    ...pill,
    idx: i
  };
}
function _temp9(a_0, b_0) {
  if (a_0.isIdle !== b_0.isIdle) {
    return a_0.isIdle ? 1 : -1;
  }
  return 0;
}
function _temp8(t_2) {
  return {
    name: t_2.identity.agentName,
    color: getAgentThemeColor(t_2.identity.color),
    isIdle: t_2.isIdle,
    taskId: t_2.id
  };
}
function _temp7(a, b) {
  return a.identity.agentName.localeCompare(b.identity.agentName);
}
function _temp6(t_1) {
  return t_1.type === "in_process_teammate";
}
function _temp5(t_0) {
  return t_0.type === "in_process_teammate";
}
function _temp4(s_1) {
  return s_1.expandedView;
}
function _temp3(t) {
  return isBackgroundTask(t) && !(false && isPanelAgentTask(t));
}
function _temp2(s_0) {
  return s_0.viewingAgentTaskId;
}
function _temp(s) {
  return s.tasks;
}
function AgentPill(t0) {
  return null;
}
function SummaryPill(t0) {
  return null;
}
function getAgentThemeColor(colorName: string | undefined): keyof Theme | undefined {
  if (!colorName) return undefined;
  if (AGENT_COLORS.includes(colorName as AgentColorName)) {
    return AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName];
  }
  return undefined;
}
