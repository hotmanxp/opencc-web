// @ts-nocheck
import React, { useCallback, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import type { ConfigScope } from '../../services/mcp/types.js';
import { describeMcpConfigFilePath } from '../../services/mcp/utils.js';
import type { AgentMcpServerInfo, ServerInfo } from './types.js';
type Props = {
  servers: ServerInfo[];
  agentServers?: AgentMcpServerInfo[];
  onSelectServer: (server: ServerInfo) => void;
  onSelectAgentServer?: (agentServer: AgentMcpServerInfo) => void;
  onComplete: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  defaultTab?: string;
};
type SelectableItem = {
  type: 'server';
  server: ServerInfo;
} | {
  type: 'agent-server';
  agentServer: AgentMcpServerInfo;
};

// Define scope order for display (constant, outside component)
// 'dynamic' (built-in) is rendered separately at the end
const SCOPE_ORDER: ConfigScope[] = ['project', 'local', 'user', 'enterprise'];

// Get scope heading parts (label is bold, path is grey)
function getScopeHeading(scope: ConfigScope): {
  label: string;
  path?: string;
} {
  switch (scope) {
    case 'project':
      return {
        label: 'Project MCPs',
        path: describeMcpConfigFilePath(scope)
      };
    case 'user':
      return {
        label: 'User MCPs',
        path: describeMcpConfigFilePath(scope)
      };
    case 'local':
      return {
        label: 'Local MCPs',
        path: describeMcpConfigFilePath(scope)
      };
    case 'enterprise':
      return {
        label: 'Enterprise MCPs'
      };
    case 'dynamic':
      return {
        label: 'Built-in MCPs',
        path: 'always available'
      };
    default:
      return {
        label: scope
      };
  }
}

// Group servers by scope
function groupServersByScope(serverList: ServerInfo[]): Map<ConfigScope, ServerInfo[]> {
  const groups = new Map<ConfigScope, ServerInfo[]>();
  for (const server of serverList) {
    const scope = server.scope;
    if (!groups.has(scope)) {
      groups.set(scope, []);
    }
    groups.get(scope)!.push(server);
  }
  // Sort servers within each group alphabetically
  for (const [, groupServers] of groups) {
    groupServers.sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups;
}
export function MCPListPanel(t0: Props): React.ReactNode | null {
  return null;
}
function _temp6(s_2: AgentMcpServerInfo) {
  return s_2.sourceAgents;
}
function _temp5(s_1) {
  return s_1.client.type === "failed";
}
function _temp4(a_0, b_0) {
  return a_0.name.localeCompare(b_0.name);
}
function _temp3(a, b) {
  return a.name.localeCompare(b.name);
}
function _temp2(s_0) {
  return s_0.client.config.type === "claudeai-proxy";
}
function _temp(s) {
  return s.client.config.type !== "claudeai-proxy";
}
