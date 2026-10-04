// @ts-nocheck
import React from 'react';
import { Text } from '../../ink.js'
import type { Tool } from '../../Tool.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import type { ServerInfo } from './types.js';
type Props = {
  tool: Tool;
  server: ServerInfo;
  onBack: () => void;
};
export function MCPToolDetailView(t0: Props): React.ReactNode | null {
  return null;
}
function _temp(exitState) {
  return exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />;
}
