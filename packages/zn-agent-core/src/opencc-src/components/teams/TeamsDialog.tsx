// @ts-nocheck
import { randomUUID } from 'crypto';
import figures from 'figures';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw j/k/arrow dialog navigation
import { Text } from '../../ink.js'
import { type AppState } from '../../state/AppState.js'
import { getEmptyToolPermissionContext } from '../../Tool.js';
import { logForDebugging } from '../../utils/debug.js';
import { execFileNoThrow } from '../../utils/execFileNoThrow.js';
import { getNextPermissionMode } from '../../utils/permissions/getNextPermissionMode.js';
import { type PermissionMode, permissionModeFromString } from '../../utils/permissions/PermissionMode.js'
import { jsonStringify } from '../../utils/slowOperations.js';
import { IT2_COMMAND, isInsideTmuxSync } from '../../utils/swarm/backends/detection.js';
import { ensureBackendsRegistered, getBackendByType } from '../../utils/swarm/backends/registry.js'
import type { PaneBackendType } from '../../utils/swarm/backends/types.js';
import { getSwarmSocketName, TMUX_COMMAND } from '../../utils/swarm/constants.js';
import { removeMemberFromTeam, setMemberMode, setMultipleMemberModes } from '../../utils/swarm/teamHelpers.js'
import { unassignTeammateTasks } from '../../utils/tasks.js'
import { type TeammateStatus, type TeamSummary } from '../../utils/teamDiscovery.js'
import { createModeSetRequestMessage, writeToMailbox } from '../../utils/teammateMailbox.js'
type Props = {
  initialTeams?: TeamSummary[];
  onDone: () => void;
};

/**
 * Dialog for viewing teammates in the current team
 */
export function TeamsDialog({
  initialTeams,
  onDone
}: Props): React.ReactNode | null {
  // Register as overlay so CancelRequestHandler doesn't intercept escape
  return null;
}
function TeamDetailView(t0) {
  return null;
}
function TeammateListItem(t0) {
  return null;
}
function TeammateDetailView(t0) {
  return null;
}
function _temp2(task_0) {
  return <Text key={task_0.id} color={task_0.status === "completed" ? "success" : undefined}>{task_0.status === "completed" ? figures.tick : "\u25FC"}{" "}{task_0.subject}</Text>;
}
function _temp(prev) {
  return !prev;
}
async function killTeammate(paneId: string, backendType: PaneBackendType | undefined, teamName: string, teammateId: string, teammateName: string, setAppState: (f: (prev: AppState) => AppState) => void): Promise<void> {
  // Kill the pane using the backend that created it (handles -s / -L flags correctly).
  // Wrapped in try/catch so cleanup (removeMemberFromTeam, unassignTeammateTasks,
  // setAppState) always runs — matches useInboxPoller.ts error isolation.
  if (backendType) {
    try {
      // Use ensureBackendsRegistered (not detectAndGetBackend) — this process may
      // be a teammate that never ran detection, but we only need class imports
      // here, not subprocess probes that could throw in a different environment.
      await ensureBackendsRegistered();
      await getBackendByType(backendType).killPane(paneId, !isInsideTmuxSync());
    } catch (error) {
      logForDebugging(`[TeamsDialog] Failed to kill pane ${paneId}: ${error}`);
    }
  } else {
    // backendType undefined: old team files predating this field, or in-process.
    // Old tmux-file case is a migration gap — the pane is orphaned. In-process
    // teammates have no pane to kill, so this is correct for them.
    logForDebugging(`[TeamsDialog] Skipping pane kill for ${paneId}: no backendType recorded`);
  }
  // Remove from team config file
  removeMemberFromTeam(teamName, paneId);

  // Unassign tasks and build notification message
  const {
    notificationMessage
  } = await unassignTeammateTasks(teamName, teammateId, teammateName, 'terminated');

  // Update AppState to keep status line in sync and notify the lead
  setAppState(prev => {
    if (!prev.teamContext?.teammates) return prev;
    if (!(teammateId in prev.teamContext.teammates)) return prev;
    const {
      [teammateId]: _,
      ...remainingTeammates
    } = prev.teamContext.teammates;
    return {
      ...prev,
      teamContext: {
        ...prev.teamContext,
        teammates: remainingTeammates
      },
      inbox: {
        messages: [...prev.inbox.messages, {
          id: randomUUID(),
          from: 'system',
          text: jsonStringify({
            type: 'teammate_terminated',
            message: notificationMessage
          }),
          timestamp: new Date().toISOString(),
          status: 'pending' as const
        }]
      }
    };
  });
  logForDebugging(`[TeamsDialog] Removed ${teammateId} from teamContext`);
}
async function viewTeammateOutput(paneId: string, backendType: PaneBackendType | undefined): Promise<void> {
  if (backendType === 'iterm2') {
    // -s is required to target a specific session (ITermBackend.ts:216-217)
    await execFileNoThrow(IT2_COMMAND, ['session', 'focus', '-s', paneId]);
  } else {
    // External-tmux teammates live on the swarm socket — without -L, this
    // targets the default server and silently no-ops. Mirrors runTmuxInSwarm
    // in TmuxBackend.ts:85-89.
    const args = isInsideTmuxSync() ? ['select-pane', '-t', paneId] : ['-L', getSwarmSocketName(), 'select-pane', '-t', paneId];
    await execFileNoThrow(TMUX_COMMAND, args);
  }
}

/**
 * Toggle visibility of a teammate pane (hide if visible, show if hidden)
 */
async function toggleTeammateVisibility(teammate: TeammateStatus, teamName: string): Promise<void> {
  if (teammate.isHidden) {
    await showTeammate(teammate, teamName);
  } else {
    await hideTeammate(teammate, teamName);
  }
}

/**
 * Hide a teammate pane using the backend abstraction.
 * Only available for ant users (gated for dead code elimination in external builds)
 */
async function hideTeammate(teammate: TeammateStatus, teamName: string): Promise<void> {}

/**
 * Show a previously hidden teammate pane using the backend abstraction.
 * Only available for ant users (gated for dead code elimination in external builds)
 */
async function showTeammate(teammate: TeammateStatus, teamName: string): Promise<void> {}

/**
 * Send a mode change message to a single teammate
 * Also updates config.json directly so the UI reflects the change immediately
 */
function sendModeChangeToTeammate(teammateName: string, teamName: string, targetMode: PermissionMode): void {
  // Update config.json directly so UI shows the change immediately
  setMemberMode(teamName, teammateName, targetMode);

  // Also send message so teammate updates their local permission context
  const message = createModeSetRequestMessage({
    mode: targetMode,
    from: 'team-lead'
  });
  void writeToMailbox(teammateName, {
    from: 'team-lead',
    text: jsonStringify(message),
    timestamp: new Date().toISOString()
  }, teamName);
  logForDebugging(`[TeamsDialog] Sent mode change to ${teammateName}: ${targetMode}`);
}

/**
 * Cycle a single teammate's mode
 */
function cycleTeammateMode(teammate: TeammateStatus, teamName: string, isBypassAvailable: boolean): void {
  const currentMode = teammate.mode ? permissionModeFromString(teammate.mode) : 'default';
  const context = {
    ...getEmptyToolPermissionContext(),
    mode: currentMode,
    isBypassPermissionsModeAvailable: isBypassAvailable
  };
  const nextMode = getNextPermissionMode(context);
  sendModeChangeToTeammate(teammate.name, teamName, nextMode);
}

/**
 * Cycle all teammates' modes in tandem
 * If modes differ, reset all to default first
 * If same, cycle all to next mode
 * Uses batch update to avoid race conditions
 */
function cycleAllTeammateModes(teammates: TeammateStatus[], teamName: string, isBypassAvailable: boolean): void {
  if (teammates.length === 0) return;
  const modes = teammates.map(t => t.mode ? permissionModeFromString(t.mode) : 'default');
  const allSame = modes.every(m => m === modes[0]);

  // Determine target mode for all teammates
  const targetMode = !allSame ? 'default' : getNextPermissionMode({
    ...getEmptyToolPermissionContext(),
    mode: modes[0] ?? 'default',
    isBypassPermissionsModeAvailable: isBypassAvailable
  });

  // Batch update config.json in a single atomic operation
  const modeUpdates = teammates.map(t => ({
    memberName: t.name,
    mode: targetMode
  }));
  setMultipleMemberModes(teamName, modeUpdates);

  // Send mailbox messages to each teammate
  for (const teammate of teammates) {
    const message = createModeSetRequestMessage({
      mode: targetMode,
      from: 'team-lead'
    });
    void writeToMailbox(teammate.name, {
      from: 'team-lead',
      text: jsonStringify(message),
      timestamp: new Date().toISOString()
    }, teamName);
  }
  logForDebugging(`[TeamsDialog] Sent mode change to all ${teammates.length} teammates: ${targetMode}`);
}
