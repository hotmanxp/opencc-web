import type { LegacyTool, LegacyToolContext } from '../Tool.js'
import { TaskUpdateInputSchema, type TaskUpdateInput } from './schema.js'
import { renderTaskUpdatePrompt } from './prompt.js'
import { getTaskListStore } from '../Tasks/TaskListStore.js'

export const TASK_UPDATE_TOOL_NAME = 'TaskUpdate'

function requireSessionId(ctx: LegacyToolContext): string {
  const sid = (ctx.__runtimeConfig as { sessionId?: string } | undefined)?.sessionId
  if (!sid) {
    throw new Error('TaskUpdate: missing ctx.__runtimeConfig.sessionId (transcriptId)')
  }
  return sid
}

export const TaskUpdateTool: LegacyTool<typeof TaskUpdateInputSchema, string> = {
  name: TASK_UPDATE_TOOL_NAME,
  description: renderTaskUpdatePrompt(),
  inputSchema: TaskUpdateInputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => false,
  isDestructive: () => false,

  async call(rawInput, ctx) {
    const input = rawInput as TaskUpdateInput
    const { taskId, ...patch } = input
    try {
      const sessionId = requireSessionId(ctx)
      const store = getTaskListStore()

      // 先读 — 跨 session 的 taskId 直接返回 task_not_found,
      // 不要再走 update 路径 (避免泄露"该 ID 在其他 session 存在"的信号)。
      const current = await store.get(sessionId, taskId)
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
        await store.update(sessionId, taskId, { blocks })
        updatedFields.push('blocks')
      }
      if (patch.addBlockedBy && patch.addBlockedBy.length > 0) {
        const blockedBy = Array.from(new Set([...current.blockedBy, ...patch.addBlockedBy]))
        await store.update(sessionId, taskId, { blockedBy })
        updatedFields.push('blockedBy')
      }

      const finalPatch: Parameters<typeof store.update>[2] = {}
      if (patch.subject !== undefined) { finalPatch.subject = patch.subject; updatedFields.push('subject') }
      if (patch.description !== undefined) { finalPatch.description = patch.description; updatedFields.push('description') }
      if (patch.activeForm !== undefined) { finalPatch.activeForm = patch.activeForm; updatedFields.push('activeForm') }
      if (patch.status !== undefined) { finalPatch.status = patch.status; updatedFields.push('status') }
      if (patch.owner !== undefined) { finalPatch.owner = patch.owner; updatedFields.push('owner') }
      if (patch.metadata !== undefined) { finalPatch.metadata = patch.metadata; updatedFields.push('metadata') }

      const updated = await store.update(sessionId, taskId, finalPatch)
      if (!updated) {
        // update 路径上的兜底: get 拿到了,但 update 时被删/竞态删除 — 报 not_found。
        return {
          output: JSON.stringify({ success: false, taskId, error: 'task_not_found' }),
          isError: true,
        }
      }
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