// @ts-nocheck
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import { type Tool, type Tools } from '../../../Tool.js'
import type { ProgressMessage } from '../../../types/message.js';
type Props = {
  progressMessagesForMessage: ProgressMessage[];
  tool?: Tool; // undefined when resuming an old conversation that uses an old tool
  tools: Tools;
  param: ToolResultBlockParam;
  verbose: boolean;
  isTranscriptMode?: boolean;
};
export function UserToolErrorMessage(t0) {
  return null;
}
