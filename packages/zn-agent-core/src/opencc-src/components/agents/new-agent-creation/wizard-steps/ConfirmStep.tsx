// @ts-nocheck
import React, { type ReactNode } from 'react';
import { Text } from '../../../../ink.js'
import type { Tools } from '../../../../Tool.js';
import type { AgentDefinition } from '../../../../tools/AgentTool/loadAgentsDir.js';
type Props = {
  tools: Tools;
  existingAgents: AgentDefinition[];
  onSave: () => void;
  onSaveAndEdit: () => void;
  error?: string | null;
};
export function ConfirmStep(t0: Props): React.ReactNode | null {
  return null;
}
function _temp3(err, i_0) {
  return <Text key={i_0} color="error">{" "}• {err}</Text>;
}
function _temp2(warning, i) {
  return <Text key={i} dimColor={true}>{" "}• {warning}</Text>;
}
function _temp(toolNames) {
  if (toolNames === undefined) {
    return "All tools";
  }
  if (toolNames.length === 0) {
    return "None";
  }
  if (toolNames.length === 1) {
    return toolNames[0] || "None";
  }
  if (toolNames.length === 2) {
    return toolNames.join(" and ");
  }
  return `${toolNames.slice(0, -1).join(", ")}, and ${toolNames[toolNames.length - 1]}`;
}
