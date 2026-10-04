import React, { useEffect, useMemo } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
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
