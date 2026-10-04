// @ts-nocheck
import type { ContentBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import { type UUID } from 'crypto'
import figures from 'figures';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type DiffStats } from 'src/utils/fileHistory.js'
import type { Message, PartialCompactDirection, UserMessage } from '../types/message.js';
import { isToolUseResultMessage } from '../utils/messages.js'
function isTextBlock(block: ContentBlockParam): block is TextBlockParam {
  return block.type === 'text';
}
import * as path from 'path';
import type { FileEditOutput } from 'src/tools/FileEditTool/types.js';
import type { Output as FileWriteToolOutput } from 'src/tools/FileWriteTool/FileWriteTool.js';
import { count } from '../utils/array.js';
type RestoreOption = 'both' | 'conversation' | 'code' | 'summarize' | 'summarize_up_to' | 'nevermind';
function isSummarizeOption(option: RestoreOption | null): option is 'summarize' | 'summarize_up_to' {
  return option === 'summarize' || option === 'summarize_up_to';
}
type Props = {
  messages: Message[];
  onPreRestore: () => void;
  onRestoreMessage: (message: UserMessage) => Promise<void>;
  onRestoreCode: (message: UserMessage) => Promise<void>;
  onSummarize: (message: UserMessage, feedback?: string, direction?: PartialCompactDirection) => Promise<void>;
  onClose: () => void;
  /** Skip pick-list, land on confirm. Caller ran skip-check first. Esc closes fully (no back-to-list). */
  preselectedMessage?: UserMessage;
};
const MAX_VISIBLE_MESSAGES = 7;
export function MessageSelector({
  messages,
  onPreRestore,
  onRestoreMessage,
  onRestoreCode,
  onSummarize,
  onClose,
  preselectedMessage
}: Props): React.ReactNode | null {
  return null;
}
function getRestoreOptionConversationText(option: RestoreOption): string {
  switch (option) {
    case 'summarize':
      return 'Messages after this point will be summarized.';
    case 'summarize_up_to':
      return 'Preceding messages will be summarized. This and subsequent messages will remain unchanged — you will stay at the end of the conversation.';
    case 'both':
    case 'conversation':
      return 'The conversation will be forked.';
    case 'code':
    case 'nevermind':
      return 'The conversation will be unchanged.';
  }
}
function RestoreOptionDescription(t0) {
  return null;
}
function RestoreCodeConfirmation(t0) {
  return null;
}
function DiffStatsText(t0) {
  return null;
}
function UserMessageOption(t0) {
  return null;
}

/**
 * Computes the diff stats for all the file edits in-between two messages.
 */
function computeDiffStatsBetweenMessages(messages: Message[], fromMessageId: UUID, toMessageId: UUID | undefined): DiffStats | undefined {
  const startIndex = messages.findIndex(msg => msg.uuid === fromMessageId);
  if (startIndex === -1) {
    return undefined;
  }
  let endIndex = toMessageId ? messages.findIndex(msg => msg.uuid === toMessageId) : messages.length;
  if (endIndex === -1) {
    endIndex = messages.length;
  }
  const filesChanged: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (let i = startIndex + 1; i < endIndex; i++) {
    const msg = messages[i];
    if (!msg || !isToolUseResultMessage(msg)) {
      continue;
    }
    const result = msg.toolUseResult as FileEditOutput | FileWriteToolOutput;
    if (!result || !result.filePath || !result.structuredPatch) {
      continue;
    }
    if (!filesChanged.includes(result.filePath)) {
      filesChanged.push(result.filePath);
    }
    try {
      if ('type' in result && result.type === 'create') {
        insertions += result.content.split(/\r?\n/).length;
      } else {
        for (const hunk of result.structuredPatch) {
          const additions = count(hunk.lines, line => line.startsWith('+'));
          const removals = count(hunk.lines, line => line.startsWith('-'));
          insertions += additions;
          deletions += removals;
        }
      }
    } catch {
      continue;
    }
  }
  return {
    filesChanged,
    insertions,
    deletions
  };
}
