// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import { basename } from 'path';
import * as React from 'react';
import { useIdeConnectionStatus } from '../hooks/useIdeConnectionStatus.js';
import type { IDESelection } from '../hooks/useIdeSelection.js';
import { Text } from '../ink.js';
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
