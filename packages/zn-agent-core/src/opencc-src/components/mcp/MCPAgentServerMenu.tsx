// @ts-nocheck
import figures from '../../utils/figures-safe.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { Box, color, Link, Text, useTheme } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { AuthenticationCancelledError, performMCPOAuthFlow } from '../../services/mcp/auth.js';
import { capitalize } from '../../utils/stringUtils.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Select, type OptionWithDescription } from '../CustomSelect/index.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { Spinner } from '../Spinner.js';
import type { AgentMcpServerInfo } from './types.js';
type Props = {
  agentServer: AgentMcpServerInfo;
  onCancel: () => void;
  onComplete?: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};

/**
 * Menu for agent-specific MCP servers.
 * These servers are defined in agent frontmatter and only connect when the agent runs.
 * For HTTP/SSE servers, this allows pre-authentication before using the agent.
 */
export function MCPAgentServerMenu({
  agentServer,
  onCancel,
  onComplete
}: Props): React.ReactNode | null {
  return null;
}
