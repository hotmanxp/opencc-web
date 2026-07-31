import type { z } from 'zod'
import type { Tool } from '../../runtime/modelCaller.js'
import { makeTool } from '../index.js'
import { getTaskListStore } from '../../taskListStore.js'
import { TaskListInput } from './schemas.js'

async function listExecutor(
  _input: z.infer<typeof TaskListInput>,
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
    "List all non-deleted tasks for the current session. Returns an array sorted by " +
    'createdAt ascending. Use this when you need to see current state before updating.',
  inputSchema: TaskListInput,
  executor: listExecutor,
})
