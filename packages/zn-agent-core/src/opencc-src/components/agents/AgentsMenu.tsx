import chalk from 'chalk';
import * as React from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import type { Tools } from '../../Tool.js';
import { type AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { ModeState } from './types.js';
type Props = {
  tools: Tools;
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  onSetActiveAgent?: (agent: AgentDefinition) => void;
  initialModeState?: ModeState;
};
export function AgentsMenu(t0) {
  return null;
}
function _temp0(a_5) {
  return a_5.source === "plugin";
}
function _temp9(a_4) {
  return a_4.source === "flagSettings";
}
function _temp8(a_3) {
  return a_3.source === "localSettings";
}
function _temp7(a_2) {
  return a_2.source === "policySettings";
}
function _temp6(a_1) {
  return a_1.source === "projectSettings";
}
function _temp5(a_0) {
  return a_0.source === "userSettings";
}
function _temp4(a) {
  return a.source === "built-in";
}
function _temp3(s_1) {
  return s_1.toolPermissionContext;
}
function _temp2(s_0) {
  return s_0.mcp.tools;
}
function _temp(s) {
  return s.agentDefinitions;
}
