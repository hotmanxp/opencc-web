import * as React from 'react';
import { type Tool, type Tools } from '../../../Tool.js'
import type { NormalizedUserMessage, ProgressMessage } from '../../../types/message.js';
import { type buildMessageLookups } from '../../../utils/messages.js'
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
