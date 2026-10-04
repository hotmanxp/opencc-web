// @ts-nocheck
import type { Command } from '../../commands.js';
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js';
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js';
type Props = {
  onDone(): void;
  commands?: Command[];
};
export function TrustDialog(t0) {
  return null;
}
function _temp7() {
  gracefulShutdownSync(0);
}
function _temp6() {
  return gracefulShutdownSync(1);
}
function _temp5(current) {
  return {
    ...current,
    hasTrustDialogAccepted: true
  };
}
function _temp4(command_0) {
  return command_0.type === "prompt" && (command_0.loadedFrom === "skills" || command_0.loadedFrom === "plugin") && (command_0.source === "projectSettings" || command_0.source === "localSettings" || command_0.source === "plugin") && command_0.allowedTools?.some(_temp3);
}
function _temp3(tool_0) {
  return tool_0 === BASH_TOOL_NAME || tool_0.startsWith(BASH_TOOL_NAME + "(");
}
function _temp2(command) {
  return command.type === "prompt" && command.loadedFrom === "commands_DEPRECATED" && (command.source === "projectSettings" || command.source === "localSettings") && command.allowedTools?.some(_temp);
}
function _temp(tool) {
  return tool === BASH_TOOL_NAME || tool.startsWith(BASH_TOOL_NAME + "(");
}
