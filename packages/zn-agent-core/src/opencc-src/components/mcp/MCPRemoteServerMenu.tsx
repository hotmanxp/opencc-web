import React, { useEffect, useRef, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw j/k/arrow menu navigation
import type { ClaudeAIServerInfo, HTTPServerInfo, SSEServerInfo } from './types.js';
type Props = {
  server: SSEServerInfo | HTTPServerInfo | ClaudeAIServerInfo;
  serverToolsCount: number;
  onViewTools: () => void;
  onCancel: () => void;
  onComplete?: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  borderless?: boolean;
};
export function MCPRemoteServerMenu({
  server,
  serverToolsCount,
  onViewTools,
  onCancel,
  onComplete,
  borderless = false
}: Props): React.ReactNode | null {
  return null;
}
