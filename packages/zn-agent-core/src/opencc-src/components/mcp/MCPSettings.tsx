// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { useEffect, useMemo } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import {  } from '../../constants/product.js'
import { BRAND_NAME } from '../../constants.js';
import { ClaudeAuthProvider } from '../../services/mcp/auth.js';
import type { McpClaudeAIProxyServerConfig, McpHTTPServerConfig, McpSSEServerConfig, McpStdioServerConfig } from '../../services/mcp/types.js';
import { extractAgentMcpServers, filterToolsByServer } from '../../services/mcp/utils.js';
import { useAppState } from '../../state/AppState.js';
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js';
import { MCPAgentServerMenu } from './MCPAgentServerMenu.js';
import { MCPListPanel } from './MCPListPanel.js';
import { MCPRemoteServerMenu } from './MCPRemoteServerMenu.js';
import { MCPStdioServerMenu } from './MCPStdioServerMenu.js';
import { MCPToolDetailView } from './MCPToolDetailView.js';
import { MCPToolListView } from './MCPToolListView.js';
import type { AgentMcpServerInfo, MCPViewState, ServerInfo } from './types.js';
type Props = {
  onComplete: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
export function MCPSettings(t0: Props): React.ReactNode | null {
  return null;
}
function _temp4(a, b) {
  return a.name.localeCompare(b.name);
}
function _temp3(client) {
  return client.name !== "ide";
}
function _temp2(s_0) {
  return s_0.agentDefinitions;
}
function _temp(s) {
  return s.mcp;
}
