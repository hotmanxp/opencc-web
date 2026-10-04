// @ts-nocheck
import * as React from 'react';
import type { IDESelection } from '../hooks/useIdeSelection.js';
import type { MCPServerConnection } from '../services/mcp/types.js';
type IdeStatusIndicatorProps = {
  ideSelection: IDESelection | undefined;
  mcpClients?: MCPServerConnection[];
};

export function hasIdeSelection(ideSelection: IDESelection | undefined): boolean {
  return Boolean(ideSelection?.filePath || (ideSelection?.text && ideSelection.lineCount > 0));
}

export function IdeStatusIndicator(t0) {
  return null;
}
