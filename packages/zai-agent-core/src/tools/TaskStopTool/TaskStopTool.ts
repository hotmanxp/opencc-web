import type { LegacyTool } from '../Tool.js'
import { TaskStopInputSchema, type TaskStopInput } from './schema.js'
import { renderTaskStopPrompt } from './prompt.js'
import {
  getBackgroundRuntime,
  hasBackgroundRuntime,
} from '../../runtime/background/index.js'

export const TASK_STOP_TOOL_NAME = 'TaskStop'
export const KILL_SHELL_TOOL_NAME = 'KillShell'

export const TaskStopTool: LegacyTool<typeof TaskStopInputSchema, string> = {
  name: TASK_STOP_TOOL_NAME,
  // 对标 opencc 上游 TaskStopTool.aliases:
  //   aliases: ['KillShell']
  // 允许 LLM(以及老 transcript)用 `KillShell` 名字调本工具,
  // 通过 wrapAsOpenccTool → opencc Tool.aliases 走 findToolByName 命中。
  // Legacy 参数 `shell_id` 在 schema.ts 的 zod transform 里归一到 `task_id`。
  aliases: [KILL_SHELL_TOOL_NAME],
  description: renderTaskStopPrompt(),
  inputSchema: TaskStopInputSchema,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => true,

  async call(rawInput) {
    const input = rawInput as TaskStopInput
    if (!hasBackgroundRuntime()) {
      return {
        output: JSON.stringify({
          message: 'BackgroundRuntime 未初始化',
          task_id: input.task_id,
          task_type: 'local_agent',
        }, null, 2),
        isError: true,
      }
    }

    try {
      const runtime = getBackgroundRuntime()
      const task = await runtime.get(input.task_id)
      if (!task) {
        return {
          output: JSON.stringify({
            message: 'task not found',
            task_id: input.task_id,
            task_type: 'local_agent',
          }, null, 2),
          isError: true,
        }
      }
      if (task.status !== 'running' && task.status !== 'queued') {
        return {
          output: JSON.stringify({
            message: `task is not running (status=${task.status})`,
            task_id: task.id,
            task_type: 'local_agent',
          }, null, 2),
          isError: true,
        }
      }
      const result = await runtime.cancel(input.task_id, input.reason)
      if (!result.ok) {
        return {
          output: JSON.stringify({
            message: 'cancel returned ok=false',
            task_id: task.id,
            task_type: 'local_agent',
          }, null, 2),
          isError: true,
        }
      }
      return {
        output: JSON.stringify({
          message: `task stopped: ${task.id}`,
          task_id: task.id,
          task_type: 'local_agent',
          command: task.input.prompt,
        }, null, 2),
        isError: false,
      }
    } catch (err) {
      return {
        output: JSON.stringify({
          message: `TaskStop failed: ${err instanceof Error ? err.message : String(err)}`,
          task_id: input.task_id,
          task_type: 'local_agent',
        }, null, 2),
        isError: true,
      }
    }
  },
}