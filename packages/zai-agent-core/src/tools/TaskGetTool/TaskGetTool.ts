import type { LegacyTool } from '../Tool.js'
import { TaskGetInputSchema, type TaskGetInput } from './schema.js'
import { renderTaskGetPrompt } from './prompt.js'
import { getTaskListStore } from '../Tasks/TaskListStore.js'

export const TASK_GET_TOOL_NAME = 'TaskGet'

export const TaskGetTool: LegacyTool<typeof TaskGetInputSchema, string> = {
  name: TASK_GET_TOOL_NAME,
  description: renderTaskGetPrompt(),
  inputSchema: TaskGetInputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isDestructive: () => false,

  async call(rawInput) {
    const input = rawInput as TaskGetInput
    try {
      const task = await getTaskListStore().get(input.taskId)
      return {
        output: JSON.stringify({ task: task ?? null }, null, 2),
        isError: false,
      }
    } catch (err) {
      return {
        output: `TaskGet failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}