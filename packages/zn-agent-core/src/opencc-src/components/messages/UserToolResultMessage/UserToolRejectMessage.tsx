import * as React from 'react';
import { type Tool, type Tools } from '../../../Tool.js'
import type { ProgressMessage } from '../../../types/message.js';
import type { buildMessageLookups } from '../../../utils/messages.js';
type Props = {
  input: {
    [key: string]: unknown;
  };
  progressMessagesForMessage: ProgressMessage[];
  style?: 'condensed';
  tool?: Tool;
  tools: Tools;
  lookups: ReturnType<typeof buildMessageLookups>;
  verbose: boolean;
  isTranscriptMode?: boolean;
};
export function UserToolRejectMessage(t0) {
  return null;
}
