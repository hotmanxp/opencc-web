// @ts-nocheck
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { Text } from '../../ink.js'
import * as React from 'react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { VimMode, PromptInputMode } from '../../types/textInputTypes.js';
import type { ToolPermissionContext } from '../../Tool.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { getGlobalConfig } from '../../utils/config.js'

// Dead code elimination: conditional import for proactive mode
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = false || false ? require('../../proactive/index.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
const NO_OP_SUBSCRIBE = (_cb: () => void) => () => {};
const NULL = () => null;
const MAX_VOICE_HINT_SHOWS = 3;
type Props = {
  active: boolean;
  exitMessage: {
    show: boolean;
    key?: string;
  };
  vimMode: VimMode | undefined;
  mode: PromptInputMode;
  toolPermissionContext: ToolPermissionContext;
  suppressHint: boolean;
  isLoading: boolean;
  showMemoryTypeSelector?: boolean;
  tasksSelected: boolean;
  teamsSelected: boolean;
  tmuxSelected: boolean;
  teammateFooterIndex?: number;
  isPasting?: boolean;
  isSearching: boolean;
  historyQuery: string;
  setHistoryQuery: (query: string) => void;
  historyFailedMatch: boolean;
  onOpenTasksDialog?: (taskId?: string) => void;
};
function ProactiveCountdown({
  active
}: {
  active: boolean;
}) {
  return null;
}
export function PromptInputFooterLeftSide(t0) {
  return null;
}
type ModeIndicatorProps = {
  mode: PromptInputMode;
  toolPermissionContext: ToolPermissionContext;
  showHint: boolean;
  isLoading: boolean;
  tasksSelected: boolean;
  teamsSelected: boolean;
  tmuxSelected: boolean;
  teammateFooterIndex?: number;
  onOpenTasksDialog?: (taskId?: string) => void;
  active: boolean;
};
function ModeIndicator({
  mode,
  toolPermissionContext,
  showHint,
  isLoading,
  tasksSelected,
  teamsSelected,
  tmuxSelected,
  teammateFooterIndex,
  onOpenTasksDialog,
  active
}: ModeIndicatorProps): React.ReactNode | null {
  return null;
}
function getSpinnerHintParts(isLoading: boolean, escShortcut: string, todosShortcut: string, killAgentsShortcut: string, hasTaskItems: boolean, expandedView: 'none' | 'tasks' | 'teammates', hasTeammates: boolean, hasRunningAgentTasks: boolean, isKillAgentsConfirmShowing: boolean): React.ReactElement[] {
  let toggleAction: string;
  if (hasTeammates) {
    // Cycling: none → tasks → teammates → none
    switch (expandedView) {
      case 'none':
        toggleAction = 'show tasks';
        break;
      case 'tasks':
        toggleAction = 'show teammates';
        break;
      case 'teammates':
        toggleAction = 'hide';
        break;
    }
  } else {
    toggleAction = expandedView === 'tasks' ? 'hide tasks' : 'show tasks';
  }

  // Show the toggle hint only when there are task items to display or
  // teammates to cycle to
  const showToggleHint = hasTaskItems || hasTeammates;
  return [...(isLoading ? [<Text dimColor key="esc">
            <KeyboardShortcutHint shortcut={escShortcut} action="interrupt" />
          </Text>] : []), ...(!isLoading && hasRunningAgentTasks && !isKillAgentsConfirmShowing ? [<Text dimColor key="kill-agents">
            <KeyboardShortcutHint shortcut={killAgentsShortcut} action="stop agents" />
          </Text>] : []), ...(showToggleHint ? [<Text dimColor key="toggle-tasks">
            <KeyboardShortcutHint shortcut={todosShortcut} action={toggleAction} />
          </Text>] : [])];
}
function isPrStatusEnabled(): boolean {
  return getGlobalConfig().prStatusFooterEnabled ?? true;
}
