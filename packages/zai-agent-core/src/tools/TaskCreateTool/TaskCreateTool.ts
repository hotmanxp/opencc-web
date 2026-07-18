import type { LegacyTool, LegacyToolContext } from '../Tool.js'
import { TaskCreateInputSchema, type TaskCreateInput } from './schema.js'
import { renderTaskCreatePrompt } from './prompt.js'
import { getTaskListStore } from '../Tasks/TaskListStore.js'

export const TASK_CREATE_TOOL_NAME = 'TaskCreate'

/**
 * 取当前 sessionId。queryEngine.ts:435 把 options.transcriptId 注入到
 * ctx.__runtimeConfig.sessionId;与 BashTool:80 取值路径一致。
 * sessionId 缺失(罕见,fallback 为空串)时仍允许写入 — 但会被 TaskListStore
 * 抛错 (loadSession 校验)。这里直接抛,避免默默把任务挂到空 session 下。
 */
function requireSessionId(ctx: LegacyToolContext): string {
  const sid = (ctx.__runtimeConfig as { sessionId?: string } | undefined)?.sessionId
  if (!sid) {
    throw new Error('TaskCreate: missing ctx.__runtimeConfig.sessionId (transcriptId)')
  }
  return sid
}

export const TaskCreateTool: LegacyTool<typeof TaskCreateInputSchema, string> = {
  name: TASK_CREATE_TOOL_NAME,
  description: renderTaskCreatePrompt(),
  inputSchema: TaskCreateInputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => false,
  isDestructive: () => false,

  async call(rawInput, ctx) {
    const input = rawInput as TaskCreateInput
    try {
      const sessionId = requireSessionId(ctx)
      const task = await getTaskListStore().create(sessionId, input)
      return {
        output: JSON.stringify({ task: { id: task.id, subject: task.subject, status: task.status, sessionId: task.sessionId } }, null, 2),
        isError: false,
      }
    } catch (err) {
      return {
        output: `TaskCreate failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}