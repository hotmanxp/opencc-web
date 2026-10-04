// @ts-nocheck
import React, { useCallback, useMemo, useState } from 'react';
import { mcpInfoFromString } from 'src/services/mcp/mcpStringUtils.js';
import { isMcpTool } from 'src/services/mcp/utils.js';
import type { Tool, Tools } from 'src/Tool.js';
import { BashTool } from 'src/tools/BashTool/BashTool.js';
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js';
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js';
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js';
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js';
import { GlobTool } from 'src/tools/GlobTool/GlobTool.js';
import { GrepTool } from 'src/tools/GrepTool/GrepTool.js';
import { ListMcpResourcesTool } from 'src/tools/ListMcpResourcesTool/ListMcpResourcesTool.js';
import { NotebookEditTool } from 'src/tools/NotebookEditTool/NotebookEditTool.js';
import { ReadMcpResourceTool } from 'src/tools/ReadMcpResourceTool/ReadMcpResourceTool.js';
import { TaskStopTool } from 'src/tools/TaskStopTool/TaskStopTool.js';
import { TodoWriteTool } from 'src/tools/TodoWriteTool/TodoWriteTool.js';
import { TungstenTool } from 'src/tools/TungstenTool/TungstenTool.js';
import { WebFetchTool } from 'src/tools/WebFetchTool/WebFetchTool.js';
import { WebSearchTool } from 'src/tools/WebSearchTool/WebSearchTool.js';
import { isAntEmployee } from '../../utils/buildConfig.js';
type Props = {
  tools: Tools;
  initialTools: string[] | undefined;
  onComplete: (selectedTools: string[] | undefined) => void;
  onCancel?: () => void;
};
type ToolBucket = {
  name: string;
  toolNames: Set<string>;
  isMcp?: boolean;
};
type ToolBuckets = {
  READ_ONLY: ToolBucket;
  EDIT: ToolBucket;
  EXECUTION: ToolBucket;
  MCP: ToolBucket;
  OTHER: ToolBucket;
};
function getToolBuckets(): ToolBuckets {
  return {
    READ_ONLY: {
      name: 'Read-only tools',
      toolNames: new Set([GlobTool.name, GrepTool.name, ExitPlanModeV2Tool.name, FileReadTool.name, WebFetchTool.name, TodoWriteTool.name, WebSearchTool.name, TaskStopTool.name, ListMcpResourcesTool.name, ReadMcpResourceTool.name])
    },
    EDIT: {
      name: 'Edit tools',
      toolNames: new Set([FileEditTool.name, FileWriteTool.name, NotebookEditTool.name])
    },
    EXECUTION: {
      name: 'Execution tools',
      toolNames: new Set([BashTool.name, isAntEmployee() ? TungstenTool.name : undefined].filter(n => n !== undefined))
    },
    MCP: {
      name: 'MCP tools',
      toolNames: new Set(),
      // Dynamic - no static list
      isMcp: true
    },
    OTHER: {
      name: 'Other tools',
      toolNames: new Set() // Dynamic - catch-all for uncategorized tools
    }
  };
}

// Helper to get MCP server buckets dynamically
function getMcpServerBuckets(tools: Tools): Array<{
  serverName: string;
  tools: Tools;
}> {
  const serverMap = new Map<string, Tool[]>();
  tools.forEach(tool => {
    if (isMcpTool(tool)) {
      const mcpInfo = mcpInfoFromString(tool.name);
      if (mcpInfo?.serverName) {
        const existing = serverMap.get(mcpInfo.serverName) || [];
        existing.push(tool);
        serverMap.set(mcpInfo.serverName, existing);
      }
    }
  });
  return Array.from(serverMap.entries()).map(([serverName, tools]) => ({
    serverName,
    tools
  })).sort((a, b) => a.serverName.localeCompare(b.serverName));
}
export function ToolSelector(t0) {
  return null;
}
function _temp8() {}
function _temp7(t_10) {
  return t_10.name;
}
function _temp6() {}
function _temp5(t_7) {
  return t_7.name;
}
function _temp4(t_6) {
  return t_6.name;
}
function _temp3(t_4) {
  return t_4.name;
}
function _temp2(t_0) {
  return t_0.name;
}
function _temp(t) {
  return t.name;
}
