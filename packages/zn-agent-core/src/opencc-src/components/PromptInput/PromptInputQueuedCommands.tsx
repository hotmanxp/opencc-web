import * as React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'src/ink.js';
import { useAppState } from 'src/state/AppState.js';
import type { AppState } from 'src/state/AppState.js';
import { STATUS_TAG, SUMMARY_TAG, TASK_NOTIFICATION_TAG } from '../../constants/xml.js';
import { QueuedMessageProvider } from '../../context/QueuedMessageContext.js';
import { useCommandQueue } from '../../hooks/useCommandQueue.js';
import type { QueuedCommand } from '../../types/textInputTypes.js';
import { isQueuedCommandEditable, isQueuedCommandVisible } from '../../utils/messageQueueManager.js';
import { createUserMessage, EMPTY_LOOKUPS, normalizeMessages } from '../../utils/messages.js';
import { jsonParse } from '../../utils/slowOperations.js';
import { Message } from '../Message.js';
const EMPTY_SET = new Set<string>();

/**
 * Check if a command value is an idle notification that should be hidden.
 * Idle notifications are processed silently without showing to the user.
 */
function isIdleNotification(value: string): boolean {
  try {
    const parsed = jsonParse(value);
    return parsed?.type === 'idle_notification';
  } catch {
    return false;
  }
}

// Maximum number of task notification lines to show
const MAX_VISIBLE_NOTIFICATIONS = 3;

/**
 * Create a synthetic overflow notification message for capped task notifications.
 */
function createOverflowNotificationMessage(count: number): string {
  return `<${TASK_NOTIFICATION_TAG}>
<${SUMMARY_TAG}>+${count} more tasks completed</${SUMMARY_TAG}>
<${STATUS_TAG}>completed</${STATUS_TAG}>
</${TASK_NOTIFICATION_TAG}>`;
}

/**
 * Process queued commands to cap task notifications at MAX_VISIBLE_NOTIFICATIONS lines.
 * Other command types are always shown in full.
 * Idle notifications are filtered out entirely.
 */
function processQueuedCommands(queuedCommands: QueuedCommand[]): QueuedCommand[] {
  // Filter out idle notifications - they are processed silently
  const filteredCommands = queuedCommands.filter(cmd => typeof cmd.value !== 'string' || !isIdleNotification(cmd.value));

  // Separate task notifications from other commands
  const taskNotifications = filteredCommands.filter(cmd => cmd.mode === 'task-notification');
  const otherCommands = filteredCommands.filter(cmd => cmd.mode !== 'task-notification');

  // If notifications fit within limit, return all commands as-is
  if (taskNotifications.length <= MAX_VISIBLE_NOTIFICATIONS) {
    return [...otherCommands, ...taskNotifications];
  }

  // Show first (MAX_VISIBLE_NOTIFICATIONS - 1) notifications, then a summary
  const visibleNotifications = taskNotifications.slice(0, MAX_VISIBLE_NOTIFICATIONS - 1);
  const overflowCount = taskNotifications.length - (MAX_VISIBLE_NOTIFICATIONS - 1);

  // Create synthetic overflow message
  const overflowCommand: QueuedCommand = {
    value: createOverflowNotificationMessage(overflowCount),
    mode: 'task-notification'
  };
  return [...otherCommands, ...visibleNotifications, overflowCommand];
}
function PromptInputQueuedCommandsImpl(): React.ReactNode | null {
  return null;
}
export const PromptInputQueuedCommands = React.memo(PromptInputQueuedCommandsImpl);
