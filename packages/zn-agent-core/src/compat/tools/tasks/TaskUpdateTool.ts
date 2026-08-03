import type { z } from 'zod'
import type { Tool } from '../../runtime/modelCaller.js'
import { makeTool } from '../makeTool.js'
import { getTaskListStore } from '../../taskListStore.js'
import { TaskUpdateInput } from './schemas.js'

async function updateExecutor(
  input: z.infer<typeof TaskUpdateInput>,
  ctx: { sessionId?: string },
): Promise<{ output: string }> {
  if (!ctx.sessionId) {
    throw new Error('TaskUpdate requires sessionId')
  }
  const { id, ...patch } = input
  const updated = await getTaskListStore().update(ctx.sessionId, id, patch)
  if (!updated) {
    return { output: `[error] task not found: ${id}` }
  }
  return { output: JSON.stringify(updated) }
}

export const TaskUpdateTool: Tool = makeTool({
  name: 'TaskUpdate',
  description:
    'Update an existing task by id. Supports partial patches (status, subject, ' +
    'description, activeForm). Persists to disk and pushes a v2_task.changed SSE ' +
    'event so the UI updates live.',
  inputSchema: TaskUpdateInput,
  executor: updateExecutor as unknown as (
    args: unknown,
    ctx: unknown,
  ) => Promise<{ output: string }>,
})