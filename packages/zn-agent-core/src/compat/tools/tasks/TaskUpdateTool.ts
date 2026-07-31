import type { z } from 'zod'
import type { Tool } from '../../runtime/modelCaller.js'
import { makeTool } from '../index.js'
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
  return { output: updated === null ? 'null' : JSON.stringify(updated) }
}

export const TaskUpdateTool: Tool = makeTool({
  name: 'TaskUpdate',
  description:
    'Update an existing task. Use status="in_progress" when starting, ' +
    'status="completed" when done. Auto-cleanup: when all tasks in a session ' +
    "reach terminal status (completed / deleted), the session's task file is removed.",
  inputSchema: TaskUpdateInput,
  executor: updateExecutor,
})
