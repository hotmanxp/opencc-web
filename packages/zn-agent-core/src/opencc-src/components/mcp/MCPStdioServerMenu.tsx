import figures from '../../utils/figures-safe.js';
import React, { useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import type { StdioServerInfo } from './types.js';
type Props = {
  server: StdioServerInfo;
  serverToolsCount: number;
  onViewTools: () => void;
  onCancel: () => void;
  onComplete: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  borderless?: boolean;
};
export function MCPStdioServerMenu({
  server,
  serverToolsCount,
  onViewTools,
  onCancel,
  onComplete,
  borderless = false
}: Props): React.ReactNode | null {
  return null;
}
