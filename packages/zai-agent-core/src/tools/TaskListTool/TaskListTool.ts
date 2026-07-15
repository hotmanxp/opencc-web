import type { LegacyTool } from '../Tool.js'
import { TaskListInputSchema } from './schema.js'
import { renderTaskListPrompt } from './prompt.js'
import { getTaskListStore } from '../Tasks/TaskListStore.js'

export const TASK_LIST_TOOL_NAME = 'TaskList'

export const TaskListTool: LegacyTool<typeof TaskListInputSchema, string> = {
  name: TASK_LIST_TOOL_NAME,
  description: renderTaskListPrompt(),
  inputSchema: TaskListInputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isDestructive: () => false,

  async call() {
    try {
      const tasks = await getTaskListStore().list()
      const trimmed = tasks.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: t.owner,
        blockedBy: t.blockedBy,
      }))
      return { output: JSON.stringify({ tasks: trimmed }, null, 2), isError: false }
    } catch (err) {
      return {
        output: `TaskList failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}