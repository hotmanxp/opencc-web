import figures from 'figures';
import * as React from 'react';
import { SentryErrorBoundary } from 'src/components/SentryErrorBoundary.js';
import { Box, Text, useTheme } from '../../../ink.js';
import { useAppState } from '../../../state/AppState.js';
import { filterToolProgressMessages, type Tool, type Tools } from '../../../Tool.js';
import type { NormalizedUserMessage, ProgressMessage } from '../../../types/message.js';
import { deleteClassifierApproval, getClassifierApproval, getYoloClassifierApproval } from '../../../utils/classifierApprovals.js';
import { extractTag, type buildMessageLookups } from '../../../utils/messages.js';
import { MessageResponse } from '../../MessageResponse.js';
import { HookProgressMessage } from '../HookProgressMessage.js';
type Props = {
  message: NormalizedUserMessage;
  lookups: ReturnType<typeof buildMessageLookups>;
  toolUseID: string;
  progressMessagesForMessage: ProgressMessage[];
  style?: 'condensed';
  tool?: Tool;
  tools: Tools;
  verbose: boolean;
  width: number | string;
  isTranscriptMode?: boolean;
};
export function UserToolSuccessMessage({
  message,
  lookups,
  toolUseID,
  progressMessagesForMessage,
  style,
  tool,
  tools,
  verbose,
  width,
  isTranscriptMode
}: Props): React.ReactNode | null {
  return null;
}
