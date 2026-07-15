import type { LegacyTool } from '../Tool.js'
import { TaskCreateInputSchema, type TaskCreateInput } from './schema.js'
import { renderTaskCreatePrompt } from './prompt.js'
import { getTaskListStore } from '../Tasks/TaskListStore.js'

export const TASK_CREATE_TOOL_NAME = 'TaskCreate'

export const TaskCreateTool: LegacyTool<typeof TaskCreateInputSchema, string> = {
  name: TASK_CREATE_TOOL_NAME,
  description: renderTaskCreatePrompt(),
  inputSchema: TaskCreateInputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => false,
  isDestructive: () => false,

  async call(rawInput) {
    const input = rawInput as TaskCreateInput
    try {
      const task = await getTaskListStore().create(input)
      return {
        output: JSON.stringify({ task: { id: task.id, subject: task.subject, status: task.status } }, null, 2),
        isError: false,
      }
    } catch (err) {
      return {
        output: `TaskCreate failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}