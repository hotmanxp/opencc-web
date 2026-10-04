// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text, useInput } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { AgentRouteSelector } from './AgentRouteSelector.js';
import { describeRouteLine, getAgentRoute } from '../../services/api/agentRouteSettings.js';
import type { Tools } from '../../Tool.js';
import { getAgentColor } from '../../tools/AgentTool/agentColorManager.js';
import { getMemoryScopeDisplay } from '../../tools/AgentTool/agentMemory.js';
import { resolveAgentTools } from '../../tools/AgentTool/agentToolUtils.js';
import { type AgentDefinition, isBuiltInAgent } from '../../tools/AgentTool/loadAgentsDir.js';
import { getAgentModelDisplay } from '../../utils/model/agent.js';
import { Markdown } from '../Markdown.js';
import { getActualRelativeAgentFilePath } from './agentFileUtils.js';
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
