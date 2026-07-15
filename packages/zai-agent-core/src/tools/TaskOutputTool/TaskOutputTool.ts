import type { LegacyTool } from '../Tool.js'
import type { TaskEvent } from '../../runtime/background/types.js'
import {
  getBackgroundRuntime,
  hasBackgroundRuntime,
} from '../../runtime/background/index.js'
import { TaskOutputInputSchema, type TaskOutputInput } from './schema.js'

export const TASK_OUTPUT_TOOL_NAME = 'TaskOutput'
export const AGENT_OUTPUT_TOOL_NAME = 'AgentOutput'
export const BASH_OUTPUT_TOOL_NAME = 'BashOutput'

/**
 * 与 opencc 的 TaskOutputTool 对齐:轮询实际 bg-agent 任务的输出。
 *
 * zai-agent-core 复用了 BackgroundAgentResultTool 的事件流读取能力,
 * 但换用 LLM 友好的 retrieval_status 协议(success / timeout / not_ready)。
 */
export const TaskOutputTool: LegacyTool<typeof TaskOutputInputSchema, string> = {
  name: TASK_OUTPUT_TOOL_NAME,
  description: [
    '读取后台 agent 任务的当前输出。',
    'task_id 是 BackgroundAgent / 后台派发 Agent 派发时返回的 shortId。',
    '',
    '注意:子 agent 完成后,父 session 会自动通过 <task-notification> 收到结果;',
    '只有当需要查看部分进度,或者主动取消/失败后还想捞数据时,才需要调本工具。',
    '',
    '参数:',
    '- task_id:任务 ID',
    '- block:是否阻塞等待完成(默认 true)',
    '- timeout:最长等待毫秒(默认 600000 = 10 分钟,最大 600000)',
    '- tailLines:返回输出末尾多少行(默认 200)',
    '',
    '返回 retrieval_status:',
    '- success:任务已完成',
    '- timeout:已等到 timeout 仍未完成',
    '- not_ready:任务不存在或已失败',
  ].join('\n'),
  inputSchema: TaskOutputInputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isDestructive: () => false,

  async call(rawInput, ctx) {
    const input = rawInput as TaskOutputInput
    if (!hasBackgroundRuntime()) {
      return {
        output: JSON.stringify({ retrieval_status: 'not_ready', task: null, error: 'BackgroundRuntime 未初始化' }),
        isError: true,
      }
    }

    try {
      const runtime = getBackgroundRuntime()
      const start = Date.now()

      // 阻塞等待直到完成或超时
      while (true) {
        const task = await runtime.get(input.task_id)
        if (!task) {
          return {
            output: JSON.stringify({
              retrieval_status: 'not_ready',
              task: null,
            }, null, 2),
            isError: false,
          }
        }
        if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') break
        if (!input.block || Date.now() - start >= input.timeout) {
          return {
            output: JSON.stringify({
              retrieval_status: 'timeout',
              task: taskSummary(task),
            }, null, 2),
            isError: false,
          }
        }
        if (ctx.abortSignal?.aborted) {
          return {
            output: JSON.stringify({
              retrieval_status: 'timeout',
              task: taskSummary(task),
            }, null, 2),
            isError: false,
          }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250))
      }

      const finalTask = await runtime.get(input.task_id)
      if (!finalTask) {
        return {
          output: JSON.stringify({ retrieval_status: 'not_ready', task: null }, null, 2),
          isError: false,
        }
      }

      // 读所有事件 → 转文本
      const events: TaskEvent[] = []
      for await (const ev of runtime.events(input.task_id)) {
        events.push(ev)
      }
      const output = eventsToText(events)
      const tail = tailLines(output, input.tailLines)

      return {
        output: JSON.stringify({
          retrieval_status: 'success',
          task: {
            task_id: finalTask.id,
            task_type: 'local_agent',
            status: finalTask.status,
            description: finalTask.input.prompt,
            output: tail,
            error: finalTask.error,
            prompt: finalTask.input.prompt,
            result: finalTask.resultText,
          },
        }, null, 2),
        isError: finalTask.status === 'failed',
      }
    } catch (err) {
      return {
        output: JSON.stringify({
          retrieval_status: 'not_ready',
          task: null,
          error: err instanceof Error ? err.message : String(err),
        }),
        isError: true,
      }
    }
  },
}

function taskSummary(task: Awaited<ReturnType<ReturnType<typeof getBackgroundRuntime>['get']>>) {
  if (!task) return null
  return {
    task_id: task.id,
    task_type: 'local_agent',
    status: task.status,
    description: task.input.prompt,
  }
}

function eventsToText(events: TaskEvent[]): string {
  return events
    .map((ev) => {
      switch (ev.type) {
        case 'content_block_delta': {
          const delta = ev.data.delta as { text?: string } | undefined
          return delta?.text ?? ''
        }
        case 'tool_use:start': {
          const name = (ev.data.name as string | undefined) ?? 'tool'
          return `\n[tool:${name}] `
        }
        case 'tool_use:done': {
          const output = ev.data.output !== undefined ? JSON.stringify(ev.data.output) : ''
          return ` → ${output.slice(0, 500)}\n`
        }
        case 'runtime.done':
          return (ev.data.text as string | undefined) ?? ''
        case 'runtime.error': {
          const err = ev.data.error as { message?: string } | undefined
          return `[error] ${err?.message ?? ''}\n`
        }
        default:
          return ''
      }
    })
    .join('')
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n')
  return lines.length <= n ? text : lines.slice(-n).join('\n')
}