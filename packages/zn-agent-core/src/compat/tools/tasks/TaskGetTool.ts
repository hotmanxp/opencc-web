import type { z } from 'zod'
import type { Tool } from '../../runtime/modelCaller.js'
import { makeTool } from '../index.js'
import { getTaskListStore } from '../../taskListStore.js'
import { TaskGetInput } from './schemas.js'

async function getExecutor(
  input: z.infer<typeof TaskGetInput>,
  ctx: { sessionId?: string },
): Promise<{ output: string }> {
  if (!ctx.sessionId) {
    throw new Error('TaskGet requires sessionId')
  }
  const task = await getTaskListStore().get(ctx.sessionId, input.id)
  if (!task) {
    return { output: `[error] task not found: ${input.id}` }
  }
  return { output: JSON.stringify(task) }
}

export const TaskGetTool: Tool = makeTool({
  name: 'TaskGet',
  description:
    'Retrieve a single task by id. Returns null payload (error string) if the task ' +
    "doesn't exist or belongs to another session.",
  inputSchema: TaskGetInput,
  executor: getExecutor,
})
