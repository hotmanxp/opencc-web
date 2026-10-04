import type { UUID } from 'crypto';
import figures from 'figures';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Notification } from 'src/context/notifications.js';
import { getSdkBetas, getSessionId, isSessionPersistenceDisabled } from '../../../bootstrap/state.js'
import { generateSessionName } from '../../../commands/rename/generateSessionName.js';
import type { AppState } from '../../../state/AppStateStore.js';
import type { AllowedPrompt } from '../../../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js';
import { calculateContextPercentages, getContextWindowForModel } from '../../../utils/context.js';
import { logError } from '../../../utils/log.js';
// zai patch (2026-09-07, plan P1-2.1, worktree-dsh, fix-area: vendor-enqueue-imports):
// import 替换 vendor enqueue 为 zai layer wrapper
import { createUserMessage } from '../../../utils/messages.js';
import { getMainLoopModel, getRuntimeMainLoopModel } from '../../../utils/model/model.js'
import { createPromptRuleContent, isClassifierPermissionsEnabled } from '../../../utils/permissions/bashClassifier.js'
import { type PermissionMode, toExternalPermissionMode } from '../../../utils/permissions/PermissionMode.js';
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js';
import { writeFile } from 'fs/promises';
import { persistFileSnapshotIfRemote } from '../../../utils/plans.js'
import { getCurrentSessionTitle, getTranscriptPath, saveAgentName, saveCustomTitle } from '../../../utils/sessionStorage.js';
import { getSettings_DEPRECATED } from '../../../utils/settings/settings.js';
import { type OptionWithDescription } from '../../CustomSelect/index.js'
import type { PermissionRequestProps } from '../PermissionRequest.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = true ? require('../../../utils/permissions/autoModeState.js') as typeof import('../../../utils/permissions/autoModeState.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
type ResponseValue = 'yes-bypass-permissions' | 'yes-accept-edits' | 'yes-accept-edits-keep-context' | 'yes-default-keep-context' | 'yes-resume-auto-mode' | 'yes-auto-clear-context' | 'ultraplan' | 'no';

/**
 * Build permission updates for plan approval, including prompt-based rules if provided.
 * Prompt-based rules are only added when classifier permissions are enabled (Ant-only).
 */
export function buildPermissionUpdates(mode: PermissionMode, allowedPrompts?: AllowedPrompt[]): PermissionUpdate[] {
  const updates: PermissionUpdate[] = [{
    type: 'setMode',
    mode: toExternalPermissionMode(mode),
    destination: 'session'
  }];

  // Add prompt-based permission rules if provided (Ant-only feature)
  if (isClassifierPermissionsEnabled() && allowedPrompts && allowedPrompts.length > 0) {
    updates.push({
      type: 'addRules',
      rules: allowedPrompts.map(p => ({
        toolName: p.tool,
        ruleContent: createPromptRuleContent(p.prompt)
      })),
      behavior: 'allow',
      destination: 'session'
    });
  }
  return updates;
}

/**
 * Auto-name the session from the plan content when the user accepts a plan,
 * if they haven't already named it via /rename or --name. Fire-and-forget.
 * Mirrors /rename: kebab-case name, updates the prompt-border badge.
 */
export function autoNameSessionFromPlan(plan: string, setAppState: (updater: (prev: AppState) => AppState) => void, isClearContext: boolean): void {
  if (isSessionPersistenceDisabled() || getSettings_DEPRECATED()?.cleanupPeriodDays === 0) {
    return;
  }
  // On clear-context, the current session is about to be abandoned — its
  // title (which may have been set by a PRIOR auto-name) is irrelevant.
  // Checking it would make the feature self-defeating after first use.
  if (!isClearContext && getCurrentSessionTitle(getSessionId())) return;
  void generateSessionName(
  // generateSessionName tail-slices to the last 1000 chars (correct for
  // conversations, where recency matters). Plans front-load the goal and
  // end with testing steps — head-slice so Haiku sees the summary.
  // @ts-ignore - type mismatch
  [createUserMessage({
    content: plan.slice(0, 1000)
  })], new AbortController().signal).then(async name => {
    // On clear-context acceptance, regenerateSessionId() has run by now —
    // this intentionally names the NEW execution session. Do not "fix" by
    // capturing sessionId once; that would name the abandoned planning session.
    if (!name || getCurrentSessionTitle(getSessionId())) return;
    const sessionId = getSessionId() as UUID;
    const fullPath = getTranscriptPath();
    await saveCustomTitle(sessionId, name, fullPath, 'auto');
    await saveAgentName(sessionId, name, fullPath, 'auto');
    setAppState(prev => {
      if (prev.standaloneAgentContext?.name === name) return prev;
      return {
        ...prev,
        standaloneAgentContext: {
          ...prev.standaloneAgentContext,
          name
        }
      };
    });
  }).catch(logError);
}
/**
 * @internal Exported for testing. Persists the plan file before exiting plan
 * mode. Returns true on success. On write failure it logs, queues a
 * 'plan-save-error' notification, and returns false so the caller stays in
 * plan mode (does not grant permissions or resolve the tool use).
 */
export async function persistPlanFileBeforeExit({
  planFilePath,
  currentPlan,
  addNotification
}: {
  planFilePath: string;
  currentPlan: string;
  addNotification: (content: Notification) => void;
}): Promise<boolean> {
  try {
    await writeFile(planFilePath, currentPlan, 'utf-8');
    void persistFileSnapshotIfRemote();
    return true;
  } catch (e) {
    logError(`Failed to save plan file to ${planFilePath}: ${e}`);
    addNotification({
      key: 'plan-save-error',
      text: `Failed to save plan file: ${e instanceof Error ? e.message : String(e)}`,
      color: 'warning',
      priority: 'high'
    });
    return false;
  }
}
export function ExitPlanModePermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
  setStickyFooter
}: PermissionRequestProps): React.ReactNode | null {
  return null;
}

/** @internal Exported for testing. */
export function buildPlanApprovalOptions({
  showClearContext,
  showUltraplan,
  usedPercent,
  isAutoModeAvailable,
  isBypassPermissionsModeAvailable,
  planAuthorName,
  onFeedbackChange
}: {
  showClearContext: boolean;
  showUltraplan: boolean;
  usedPercent: number | null;
  isAutoModeAvailable: boolean | undefined;
  isBypassPermissionsModeAvailable: boolean | undefined;
  planAuthorName: string;
  onFeedbackChange: (v: string) => void;
}): OptionWithDescription<ResponseValue>[] {
  const options: OptionWithDescription<ResponseValue>[] = [];
  const usedLabel = usedPercent !== null ? ` (${usedPercent}% used)` : '';
  if (showClearContext) {
    if (isAutoModeAvailable) {
      options.push({
        label: `Yes, clear context${usedLabel} and use auto mode`,
        value: 'yes-auto-clear-context'
      });
    } else if (isBypassPermissionsModeAvailable) {
      options.push({
        label: `Yes, clear context${usedLabel} and bypass permissions`,
        value: 'yes-bypass-permissions'
      });
    } else {
      options.push({
        label: `Yes, clear context${usedLabel} and auto-accept edits`,
        value: 'yes-accept-edits'
      });
    }
  }

  // Slot 2: keep-context with elevated mode (same priority: auto > bypass > edits).
  if (isAutoModeAvailable) {
    options.push({
      label: 'Yes, and use auto mode',
      value: 'yes-resume-auto-mode'
    });
  } else if (isBypassPermissionsModeAvailable) {
    options.push({
      label: 'Yes, and bypass permissions',
      value: 'yes-accept-edits-keep-context'
    });
  } else {
    options.push({
      label: 'Yes, auto-accept edits',
      value: 'yes-accept-edits-keep-context'
    });
  }
  options.push({
    label: 'Yes, manually approve edits',
    value: 'yes-default-keep-context'
  });
  if (showUltraplan) {
    options.push({
      label: 'No, refine with Ultraplan on OpenCC on the web',
      value: 'ultraplan'
    });
  }
  options.push({
    type: 'input',
    label: 'No, keep planning',
    value: 'no',
    placeholder: `Tell ${planAuthorName} what to change`,
    description: 'shift+tab to approve with this feedback',
    onChange: onFeedbackChange
  });
  return options;
}
function getContextUsedPercent(usage: {
  input_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
} | undefined, permissionMode: PermissionMode): number | null {
  if (!usage) return null;
  const runtimeModel = getRuntimeMainLoopModel({
    permissionMode,
    mainLoopModel: getMainLoopModel(),
    exceeds200kTokens: false
  });
  const contextWindowSize = getContextWindowForModel(runtimeModel, getSdkBetas());
  const {
    used
  } = calculateContextPercentages({
    input_tokens: usage.input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0
  }, contextWindowSize);
  return used;
}
