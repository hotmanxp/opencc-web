import type { Task, TaskType } from './Task.ts'
import { DreamTask } from './tasks/DreamTask/DreamTask.ts'
import { LocalAgentTask } from './tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from './tasks/LocalShellTask/LocalShellTask.js'
import { LocalWorkflowTask } from './tasks/LocalWorkflowTask/LocalWorkflowTask.ts'
import { RemoteAgentTask } from './tasks/RemoteAgentTask/RemoteAgentTask.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const MonitorMcpTask: Task | null =
  require('./tasks/MonitorMcpTask/MonitorMcpTask.js').MonitorMcpTask
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Get all tasks.
 * Mirrors the pattern from tools.ts
 * Note: Returns array inline to avoid circular dependency issues with top-level const
 */
export function getAllTasks(): Task[] {
  const tasks: Task[] = [
    LocalShellTask,
    LocalAgentTask,
    RemoteAgentTask,
    DreamTask,
  ]
  if (LocalWorkflowTask) tasks.push(LocalWorkflowTask as unknown as Task)
  if (MonitorMcpTask) tasks.push(MonitorMcpTask)
  return tasks
}

/**
 * Get a task by its type.
 */
export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(t => t.type === type)
}
