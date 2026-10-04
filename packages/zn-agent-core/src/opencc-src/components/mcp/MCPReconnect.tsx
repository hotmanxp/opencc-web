// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import figures from '../../utils/figures-safe.js';
import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { Box, color, Text, useTheme } from '../../ink.js';
import { useMcpReconnect } from '../../services/mcp/MCPConnectionManager.js';
import { useAppStateStore } from '../../state/AppState.js';
import { Spinner } from '../Spinner.js';
type Props = {
  serverName: string;
  onComplete: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
export function MCPReconnect(t0) {
  return null;
}
