// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import type { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React, { useMemo } from 'react';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import type { ThemeName } from 'src/utils/theme.js';
import type { Command } from '../../commands.js';
import { BLACK_CIRCLE } from '../../constants/figures.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { Box, Text, useTheme } from '../../ink.js';
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js';
import { findToolByName, type Tool, type ToolProgressData, type Tools } from '../../Tool.js';
import type { ProgressMessage } from '../../types/message.js';
import { useIsClassifierChecking } from '../../utils/classifierApprovalsHook.js';
import { logError } from '../../utils/log.js';
import type { buildMessageLookups } from '../../utils/messages.js';
import { MessageResponse } from '../MessageResponse.js';
import { useSelectedMessageBg } from '../messageActions.js';
import { SentryErrorBoundary } from '../SentryErrorBoundary.js';
import { ToolUseLoader } from '../ToolUseLoader.js';
import { HookProgressMessage } from './HookProgressMessage.js';
type Props = {
  param: ToolUseBlockParam;
  addMargin: boolean;
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  inProgressToolUseIDs: Set<string>;
  progressMessagesForMessage: ProgressMessage[];
  shouldAnimate: boolean;
  shouldShowDot: boolean;
  inProgressToolCallCount?: number;
  lookups: ReturnType<typeof buildMessageLookups>;
  isTranscriptMode?: boolean;
};
export function AssistantToolUseMessage(t0) {
  return null;
}
function _temp3(state_1) {
  return !!state_1.toolPermissionContext.strippedDangerousRules;
}
function _temp2(state_0) {
  return state_0.toolPermissionContext.mode;
}
function _temp(state) {
  return state.pendingWorkerRequest;
}
function renderToolUseMessage(tool: Tool, input: unknown, {
  theme,
  verbose,
  commands
}: {
  theme: ThemeName;
  verbose: boolean;
  commands: Command[];
}): React.ReactNode {
  try {
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return '';
    }
    return tool.renderToolUseMessage(parsed.data, {
      theme,
      verbose,
      commands
    });
  } catch (error) {
    logError(new Error(`Error rendering tool use message for ${tool.name}: ${error}`));
    return '';
  }
}
function renderToolUseProgressMessage(tool: Tool, tools: Tools, lookups: ReturnType<typeof buildMessageLookups>, toolUseID: string, progressMessagesForMessage: ProgressMessage[], {
  verbose,
  inProgressToolCallCount,
  isTranscriptMode
}: {
  verbose: boolean;
  inProgressToolCallCount?: number;
  isTranscriptMode?: boolean;
}, terminalSize: {
  columns: number;
  rows: number;
}): React.ReactNode {
  const toolProgressMessages = progressMessagesForMessage.filter((msg): msg is ProgressMessage<ToolProgressData> => msg.data.type !== 'hook_progress');
  try {
    const toolMessages = tool.renderToolUseProgressMessage?.(toolProgressMessages, {
      tools,
      verbose,
      terminalSize,
      inProgressToolCallCount: inProgressToolCallCount ?? 1,
      isTranscriptMode
    }) ?? null;
    return <>
        <SentryErrorBoundary>
          <HookProgressMessage hookEvent="PreToolUse" lookups={lookups} toolUseID={toolUseID} verbose={verbose} isTranscriptMode={isTranscriptMode} />
        </SentryErrorBoundary>
        {toolMessages}
      </>;
  } catch (error) {
    logError(new Error(`Error rendering tool use progress message for ${tool.name}: ${error}`));
    return null;
  }
}
function renderToolUseQueuedMessage(tool: Tool): React.ReactNode {
  try {
    return tool.renderToolUseQueuedMessage?.();
  } catch (error) {
    logError(new Error(`Error rendering tool use queued message for ${tool.name}: ${error}`));
    return null;
  }
}
