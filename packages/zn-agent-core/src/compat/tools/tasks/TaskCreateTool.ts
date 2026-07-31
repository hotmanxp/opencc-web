import type { z } from 'zod'
import type { Tool } from '../../runtime/modelCaller.js'
import { makeTool } from '../index.js'
import { getTaskListStore } from '../../taskListStore.js'
import { TaskCreateInput } from './schemas.js'

async function createExecutor(
  input: z.infer<typeof TaskCreateInput>,
  ctx: { sessionId?: string },
): Promise<{ output: string }> {
  if (!ctx.sessionId) {
    throw new Error('TaskCreate requires sessionId')
  }
  const task = await getTaskListStore().create(ctx.sessionId, input)
  return { output: JSON.stringify(task) }
}

export const TaskCreateTool: Tool = makeTool({
  name: 'TaskCreate',
  description:
    "Create a new task in the current session's task list. Tasks track multi-step " +
    'work — use them to break down complex requests into trackable units. Returns the ' +
    'created task (with assigned id). Persists to disk and pushes a v2_task.changed ' +
    'SSE event so the UI updates live.',
  inputSchema: TaskCreateInput,
  executor: createExecutor,
})
