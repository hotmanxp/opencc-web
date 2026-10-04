import * as React from 'react';
import {
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { isBridgeEnabled } from '../../bridge/bridgeEnabled.js';
import { getBridgeStatus } from '../../bridge/bridgeStatusUtil.js';
import { useSetPromptOverlay } from '../../context/promptOverlayContext.js';
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js';
import type { IDESelection } from '../../hooks/useIdeSelection.js';
import { type ReadonlySettings, useSettings } from '../../hooks/useSettings.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '../../ink.js';
import type { MCPServerConnection } from '../../services/mcp/types.js';
import { useAppState } from '../../state/AppState.js';
import type { ToolPermissionContext } from '../../Tool.js';
import type { Message } from '../../types/message.js';
import { formatGoalDuration, formatTokenCount } from './goalFormat.js';
import type { PromptInputMode, VimMode } from '../../types/textInputTypes.js';
import type { AutoUpdaterResult } from '../../utils/autoUpdater.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import { isUndercover } from '../../utils/undercover.js';
import { getGlobalConfig } from '../../utils/config.js';
import { CoordinatorTaskPanel, useCoordinatorTaskCount } from '../CoordinatorAgentStatus.js';
import { getLastAssistantMessageId, StatusLine, statusLineShouldDisplay } from '../StatusLine.js';
import { Notifications } from './Notifications.js';
import { resolveFooterOverlay, resolveTransientFooterMessage } from './footerVisibility.js';
import { KeepMounted } from './KeepMounted.js';
import { PromptInputFooterLeftSide } from './PromptInputFooterLeftSide.js';
import { PromptInputFooterSuggestions, type SuggestionItem } from './PromptInputFooterSuggestions.js';
import { PromptInputHelpMenu } from './PromptInputHelpMenu.js';
import { isAntEmployee } from '../../utils/buildConfig.js';

type Props = {
  apiKeyStatus: VerificationStatus;
  debug: boolean;
  exitMessage: {
    show: boolean;
    key?: string;
  };
  vimMode: VimMode | undefined;
  mode: PromptInputMode;
  autoUpdaterResult: AutoUpdaterResult | null;
  isAutoUpdating: boolean;
  verbose: boolean;
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  suggestions: SuggestionItem[];
  selectedSuggestion: number;
  maxColumnWidth?: number;
  toolPermissionContext: ToolPermissionContext;
  helpOpen: boolean;
  suppressHint: boolean;
  isLoading: boolean;
  tasksSelected: boolean;
  teamsSelected: boolean;
  bridgeSelected: boolean;
  tmuxSelected: boolean;
  teammateFooterIndex?: number;
  ideSelection: IDESelection | undefined;
  mcpClients?: MCPServerConnection[];
  isPasting?: boolean;
  isInputWrapped?: boolean;
  messages: Message[];
  isSearching: boolean;
  historyQuery: string;
  setHistoryQuery: (query: string) => void;
  historyFailedMatch: boolean;
  onOpenTasksDialog?: (taskId?: string) => void;
};

/**
 * Pure computation for whether the footer renders a status line below the
 * prompt, and which one. Returns `'custom'` when the user's statusline
 * command fires, `'builtin'` when a no-cost builtin fallback renders, or
 * `null` when the row's render guards fail (non-prompt mode, short
 * fullscreen, exit message, paste in progress).
 *
 * The `'? for shortcuts'` discoverability hint is gated on this result —
 * see shouldSuppressShortcutsHint for the rules.
 *
 * Substance ported from upstream PR #1862 ("honest feedback pass"). The
 * `'builtin'` branch is currently a no-op for OpenCC: there is no
 * BuiltinStatusLine component (OpenCC ships only the user-configurable
 * custom status line). Plumbed in so a future builtin can drop in without
 * reshuffling call sites.
 */
export function resolveFooterStatusLine(
  settings: ReadonlySettings,
  guards: {
    isPromptMode: boolean;
    isShort: boolean;
    exitMessageShown: boolean;
    isPasting: boolean;
  },
): 'custom' | 'builtin' | null {
  if (
    !guards.isPromptMode ||
    guards.isShort ||
    guards.exitMessageShown ||
    guards.isPasting
  ) {
    return null;
  }
  if (statusLineShouldDisplay(settings)) return 'custom';
  return null; // OpenCC: no builtin status line today
}

export function resolveConfiguredFooterStatusLine(settings: ReadonlySettings): 'custom' | 'builtin' | null {
  return resolveFooterStatusLine(settings, {
    isPromptMode: true,
    isShort: false,
    exitMessageShown: false,
    isPasting: false
  });
}

/**
 * Number of startup sessions before the `? for shortcuts` discoverability
 * hint is hidden on built-in status-line users. New users see the hint
 * alongside the builtin; established users get a quieter footer. Custom
 * status-line users always hide the hint regardless of tenure.
 */
export const SHORTCUTS_HINT_STARTUP_GRACE = 10;

/**
 * Whether to suppress the `? for shortcuts` discoverability hint. The hint
 * must never disappear from a state where no status line actually renders,
 * so caller-suppressed and search-in-progress always win. Custom status
 * lines — explicit user configuration — also win regardless of tenure.
 * Built-in status lines only suppress for established users.
 *
 * OpenCC has no builtin status line today, so the `'builtin'` branch is a
 * no-op (see resolveFooterStatusLine). Substance ported from upstream
 * PR #1862.
 */
export function shouldSuppressShortcutsHint(args: {
  suppressedByCaller: boolean;
  footerStatusLine: 'custom' | 'builtin' | null;
  isSearching: boolean;
  numStartups: number;
}): boolean {
  if (args.suppressedByCaller || args.isSearching) return true;
  if (args.footerStatusLine === 'custom') return true;
  return (
    args.footerStatusLine === 'builtin' &&
    args.numStartups > SHORTCUTS_HINT_STARTUP_GRACE
  );
}

function PromptInputFooter({
  apiKeyStatus,
  debug,
  exitMessage,
  vimMode,
  mode,
  autoUpdaterResult,
  isAutoUpdating,
  verbose,
  onAutoUpdaterResult,
  onChangeIsUpdating,
  suggestions,
  selectedSuggestion,
  maxColumnWidth,
  toolPermissionContext,
  helpOpen,
  suppressHint: suppressHintFromProps,
  isLoading,
  tasksSelected,
  teamsSelected,
  bridgeSelected,
  tmuxSelected,
  teammateFooterIndex,
  ideSelection,
  mcpClients,
  isPasting = false,
  isInputWrapped = false,
  messages,
  isSearching,
  historyQuery,
  setHistoryQuery,
  historyFailedMatch,
  onOpenTasksDialog
}: Props): ReactNode | null {
  return null;
}
export default memo(PromptInputFooter);

type BridgeStatusProps = {
  bridgeSelected: boolean;
};
function BridgeStatusIndicator({
  bridgeSelected
}: BridgeStatusProps): React.ReactNode | null {
  return null;
}
function GoalStatusIndicator(): React.ReactNode | null {
  return null;
}

