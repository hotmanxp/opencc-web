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
}: Props): ReactNode {
  const settings = useSettings();
  const {
    columns,
    rows
  } = useTerminalSize();
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const lastAssistantMessageId = useMemo(() => getLastAssistantMessageId(messages), [messages]);
  const isNarrow = columns < 80;
  // In fullscreen the bottom slot is flexShrink:0, so every row here is a row
  // stolen from the ScrollBox. Drop the optional StatusLine first. Non-fullscreen
  // has terminal scrollback to absorb overflow, so we never hide StatusLine there.
  const isFullscreen = isFullscreenEnvEnabled();
  const isShort = isFullscreen && rows < 24;
  const footerOverlay = resolveFooterOverlay({
    hasInlineSuggestions: suggestions.length > 0 && !isFullscreen,
    helpOpen,
    isSearching
  });
  const hideRegularFooter = footerOverlay !== null;

  // Pill highlights when tasks is the active footer item AND no specific
  // agent row is selected. When coordinatorTaskIndex >= 0 the pointer has
  // moved into CoordinatorTaskPanel, so the pill should un-highlight.
  // coordinatorTaskCount === 0 covers the bash-only case (no agent rows
  // exist, pill is the only selectable item).
  const coordinatorTaskCount = useCoordinatorTaskCount();
  const coordinatorTaskIndex = useAppState(s => s.coordinatorTaskIndex);
  const pillSelected = tasksSelected && (coordinatorTaskCount === 0 || coordinatorTaskIndex < 0);

  // Which status line (if any) actually renders below the prompt. Together
  // with the search flag and caller suppression, this drives the
  // `? for shortcuts` discoverability hint — see shouldSuppressShortcutsHint.
  // Plumbed in even though OpenCC has no builtin status line today so a
  // future builtin can drop in without reshuffling call sites.
  // (Substance ported from upstream PR #1862.)
  const footerStatusLine = resolveFooterStatusLine(settings, {
    isPromptMode: mode === 'prompt',
    isShort,
    exitMessageShown: exitMessage.show,
    isPasting,
  });
  const configuredFooterStatusLine = resolveConfiguredFooterStatusLine(settings);
  // Hide `? for shortcuts` during ctrl-r search, or — for established users
  // only — when a status line actually renders. A custom status line is
  // explicit user configuration, so it always wins. See
  // shouldSuppressShortcutsHint for the full rules.
  const suppressHint = shouldSuppressShortcutsHint({
    suppressedByCaller: suppressHintFromProps,
    footerStatusLine,
    isSearching,
    numStartups: getGlobalConfig().numStartups,
  });
  // Fullscreen: portal data to FullscreenLayout — see promptOverlayContext.tsx
  const overlayData = useMemo(() => isFullscreen && suggestions.length ? {
    suggestions,
    selectedSuggestion,
    maxColumnWidth
  } : null, [isFullscreen, suggestions, selectedSuggestion, maxColumnWidth]);
  useSetPromptOverlay(overlayData);
  return <>
      <KeepMounted hidden={hideRegularFooter}>
        <Box flexDirection={isNarrow ? 'column' : 'row'} justifyContent={isNarrow ? 'flex-start' : 'space-between'} paddingX={2} gap={isNarrow ? 0 : 1}>
          <Box flexDirection="column" flexShrink={isNarrow ? 0 : 1}>
          <KeepMounted hidden={footerStatusLine === null}>
{configuredFooterStatusLine === 'custom' ? <StatusLine active={footerStatusLine === 'custom'} messagesRef={messagesRef} lastAssistantMessageId={lastAssistantMessageId} vimMode={vimMode} /> : null}
          </KeepMounted>
          <PromptInputFooterLeftSide active={!hideRegularFooter} exitMessage={exitMessage} vimMode={vimMode} mode={mode} toolPermissionContext={toolPermissionContext} suppressHint={suppressHint} isLoading={isLoading} tasksSelected={pillSelected} teamsSelected={teamsSelected} teammateFooterIndex={teammateFooterIndex} tmuxSelected={tmuxSelected} isPasting={isPasting} isSearching={isSearching} historyQuery={historyQuery} setHistoryQuery={setHistoryQuery} historyFailedMatch={historyFailedMatch} onOpenTasksDialog={onOpenTasksDialog} />
          </Box>
          <Box flexShrink={1} gap={1}>
          {isFullscreen ? null : <Notifications apiKeyStatus={apiKeyStatus} autoUpdaterResult={autoUpdaterResult} debug={debug} isAutoUpdating={isAutoUpdating} verbose={verbose} messages={messages} onAutoUpdaterResult={onAutoUpdaterResult} onChangeIsUpdating={onChangeIsUpdating} ideSelection={ideSelection} mcpClients={mcpClients} isInputWrapped={isInputWrapped} isNarrow={isNarrow} />}
          {isAntEmployee() && isUndercover() && <Text dimColor>undercover</Text>}
          <BridgeStatusIndicator bridgeSelected={bridgeSelected} />
          <GoalStatusIndicator />
          </Box>
        </Box>
      </KeepMounted>
      {footerOverlay === 'suggestions' ? <Box paddingX={2} paddingY={0}>
          <PromptInputFooterSuggestions suggestions={suggestions} selectedSuggestion={selectedSuggestion} maxColumnWidth={maxColumnWidth} />
</Box> : footerOverlay === 'help' ? <PromptInputHelpMenu dimColor={true} fixedWidth={true} paddingX={2} /> : null}
      {isAntEmployee() && <CoordinatorTaskPanel />}
    </>;
}
export default memo(PromptInputFooter);

type BridgeStatusProps = {
  bridgeSelected: boolean;
};
function BridgeStatusIndicator({
  bridgeSelected
}: BridgeStatusProps): React.ReactNode {
  if (!false) return null;

  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const enabled = useAppState(s => s.replBridgeEnabled);
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const connected = useAppState(s_0 => s_0.replBridgeConnected);
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const sessionActive = useAppState(s_1 => s_1.replBridgeSessionActive);
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const reconnecting = useAppState(s_2 => s_2.replBridgeReconnecting);
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const explicit = useAppState(s_3 => s_3.replBridgeExplicit);

  // Failed state is surfaced via notification (useReplBridge), not a footer pill.
  if (!isBridgeEnabled() || !enabled) return null;
  const status = getBridgeStatus({
    error: undefined,
    connected,
    sessionActive,
    reconnecting
  });

  // For implicit (config-driven) remote, only show the reconnecting state
  if (!explicit && status.label !== 'Remote Control reconnecting') {
    return null;
  }
  return <Text color={bridgeSelected ? 'background' : status.color} inverse={bridgeSelected} wrap="truncate">
      {status.label}
      {bridgeSelected && <Text dimColor> · Enter to view</Text>}
    </Text>;
}
function GoalStatusIndicator(): React.ReactNode {
  const goal = useAppState(s => s.activeGoal);
  // 1Hz tick to keep the elapsed-seconds display fresh while the goal is
  // active. Skipped once the goal transitions to the achieved summary
  // (frozen duration, no need to re-render).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!goal || goal.achievedAt) return;
    const id = setInterval(() => setTick(t => (t + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, [goal?.achievedAt]);

  if (!goal) return null;

  // Achieved summary: `✔ Goal achieved (Xs · Y turn(s) · Zk tokens)`. The
  // `iterations` field counts Stop-hook rejections; if it's still 0 the
  // LLM approved on first try, so we show "1 turn" as the floor.
  if (goal.achievedAt) {
    const durSec = Math.max(
      0,
      Math.round((goal.achievedAt - goal.setAt) / 1000),
    );
    const turns = goal.iterations > 0 ? goal.iterations : 1;
    const turnText = turns === 1 ? '1 turn' : `${turns} turns`;
    const tokens = Math.max(0, (goal.tokensAtEnd ?? 0) - goal.tokensAtStart);
    return (
      <Text color="suggestion" wrap="truncate">
        ✔ Goal achieved ({formatGoalDuration(durSec)} · {turnText} ·{' '}
        {formatTokenCount(tokens)} tokens)
      </Text>
    );
  }

  // Active: `◎ /goal active (Ns · Xm Ys)`, ticking every second. Duration
  // switches from `Ns` to `Xm Ys` once the goal has been running for ≥60s so
  // the pill width stays bounded as time accumulates.
  const durSec = Math.max(0, Math.floor((Date.now() - goal.setAt) / 1000));
  return (
    <Text color="suggestion" wrap="truncate">
      ◎ /goal active ({formatGoalDuration(durSec)})
    </Text>
  );
}

