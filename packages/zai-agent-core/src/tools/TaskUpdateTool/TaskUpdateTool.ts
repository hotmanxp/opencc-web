import type { LegacyTool } from '../Tool.js'
import { TaskUpdateInputSchema, type TaskUpdateInput } from './schema.js'
import { renderTaskUpdatePrompt } from './prompt.js'
import { getTaskListStore } from '../Tasks/TaskListStore.js'

export const TASK_UPDATE_TOOL_NAME = 'TaskUpdate'

export const TaskUpdateTool: LegacyTool<typeof TaskUpdateInputSchema, string> = {
  name: TASK_UPDATE_TOOL_NAME,
  description: renderTaskUpdatePrompt(),
  inputSchema: TaskUpdateInputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => false,
  isDestructive: () => false,

  async call(rawInput) {
    const input = rawInput as TaskUpdateInput
    const { taskId, ...patch } = input
    try {
      const store = getTaskListStore()

      // 先处理 addBlocks / addBlockedBy
      const current = await store.get(taskId)
      if (!current) {
        return {
          output: JSON.stringify({ success: false, taskId, error: 'task_not_found' }),
          isError: true,
        }
      }

      const updatedFields: string[] = []
      const prevStatus = current.status

      if (patch.addBlocks && patch.addBlocks.length > 0) {
        const blocks = Array.from(new Set([...current.blocks, ...patch.addBlocks]))
        await store.update(taskId, { blocks })
        updatedFields.push('blocks')
      }
      if (patch.addBlockedBy && patch.addBlockedBy.length > 0) {
        const blockedBy = Array.from(new Set([...current.blockedBy, ...patch.addBlockedBy]))
        await store.update(taskId, { blockedBy })
        updatedFields.push('blockedBy')
      }

      const finalPatch: Parameters<typeof store.update>[1] = {}
      if (patch.subject !== undefined) { finalPatch.subject = patch.subject; updatedFields.push('subject') }
      if (patch.description !== undefined) { finalPatch.description = patch.description; updatedFields.push('description') }
      if (patch.activeForm !== undefined) { finalPatch.activeForm = patch.activeForm; updatedFields.push('activeForm') }
      if (patch.status !== undefined) { finalPatch.status = patch.status; updatedFields.push('status') }
      if (patch.owner !== undefined) { finalPatch.owner = patch.owner; updatedFields.push('owner') }
      if (patch.metadata !== undefined) { finalPatch.metadata = patch.metadata; updatedFields.push('metadata') }

      const updated = await store.update(taskId, finalPatch)
      const statusChange = patch.status && prevStatus !== patch.status ? { from: prevStatus, to: patch.status } : undefined
      return {
        output: JSON.stringify({
          success: true,
          taskId,
          updatedFields,
          statusChange,
        }, null, 2),
        isError: false,
      }
    } catch (err) {
      return {
        output: JSON.stringify({
          success: false,
          taskId,
          error: err instanceof Error ? err.message : String(err),
        }),
        isError: true,
      }
    }
  },
}