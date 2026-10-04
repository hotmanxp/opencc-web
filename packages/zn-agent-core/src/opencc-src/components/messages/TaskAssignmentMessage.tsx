import * as React from 'react';
import { isTaskAssignment, type TaskAssignmentMessage } from '../../utils/teammateMailbox.js';
type Props = {
  assignment: TaskAssignmentMessage;
};

/**
 * Renders a task assignment with a cyan border (team-related color).
 */
export function TaskAssignmentDisplay(t0) {
  return null;
}

/**
 * Try to parse and render a task assignment message from raw content.
 */
export function tryRenderTaskAssignmentMessage(content: string): React.ReactNode | null {
  const assignment = isTaskAssignment(content);
  if (assignment) {
    return <TaskAssignmentDisplay assignment={assignment} />;
  }
  return null;
}

/**
 * Get a brief summary text for a task assignment message.
 */
export function getTaskAssignmentSummary(content: string): string | null {
  const assignment = isTaskAssignment(content);
  if (assignment) {
    return `[Task Assigned] #${assignment.taskId} - ${assignment.subject}`;
  }
  return null;
}
