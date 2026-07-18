import type { LegacyTool, LegacyToolContext } from '../Tool.js'
import { TaskGetInputSchema, type TaskGetInput } from './schema.js'
import { renderTaskGetPrompt } from './prompt.js'
import { getTaskListStore } from '../Tasks/TaskListStore.js'

export const TASK_GET_TOOL_NAME = 'TaskGet'

function requireSessionId(ctx: LegacyToolContext): string {
  const sid = (ctx.__runtimeConfig as { sessionId?: string } | undefined)?.sessionId
  if (!sid) {
    throw new Error('TaskGet: missing ctx.__runtimeConfig.sessionId (transcriptId)')
  }
  return sid
}

export const TaskGetTool: LegacyTool<typeof TaskGetInputSchema, string> = {
  name: TASK_GET_TOOL_NAME,
  description: renderTaskGetPrompt(),
  inputSchema: TaskGetInputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isDestructive: () => false,

  async call(rawInput, ctx) {
    const input = rawInput as TaskGetInput
    try {
      const sessionId = requireSessionId(ctx)
      const task = await getTaskListStore().get(sessionId, input.taskId)
      // 跨 session 的 taskId 直接返回 null,提示 "未找到"。
      // 不抛错 — 保持 TaskGet 的"读不到 = null"语义,避免模型把 ID 写错
      // 和"跨 session 越权访问"两种情况混在一起。
      return {
        output: JSON.stringify({ task: task ?? null }, null, 2),
        isError: false,
      }
    } catch (err) {
      return {
        output: `TaskGet failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}