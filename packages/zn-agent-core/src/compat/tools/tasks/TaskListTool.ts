import type { Tool } from '../../runtime/modelCaller.js'
import { makeTool } from '../makeTool.js'
import { getTaskListStore } from '../../taskListStore.js'
import { TaskListInput } from './schemas.js'

async function listExecutor(
  _input: Record<string, never>,
  ctx: { sessionId?: string },
): Promise<{ output: string }> {
  if (!ctx.sessionId) {
    throw new Error('TaskList requires sessionId')
  }
  const tasks = await getTaskListStore().list(ctx.sessionId)
  return { output: JSON.stringify(tasks) }
}

export const TaskListTool: Tool = makeTool({
  name: 'TaskList',
  description:
    "List all non-deleted tasks in the current session's task list. Returns a JSON " +
    'array of task objects. Use to review progress before deciding which task to ' +
    'work on next.',
  inputSchema: TaskListInput,
  executor: listExecutor as unknown as (
    args: unknown,
    ctx: unknown,
  ) => Promise<{ output: string }>,
})