import type { LegacyTool } from '../Tool.js'
import type { TaskEvent } from '../../runtime/background/types.js'
import {
  getBackgroundRuntime,
  hasBackgroundRuntime,
} from '../../runtime/background/index.js'
import {
  BackgroundAgentResultInputSchema,
  type BackgroundAgentResultInput,
} from './schema.js'
import { renderBackgroundAgentResultPrompt } from './prompt.js'

export const BACKGROUND_AGENT_RESULT_TOOL_NAME = 'BackgroundAgentResult'

/**
 * 把单个 TaskEvent 转成可读文本。
 */
function eventToText(ev: TaskEvent): string {
  const ts = new Date(ev.ts).toISOString()
  switch (ev.type) {
    case 'content_block_delta': {
      const delta = ev.data.delta as { type?: string; text?: string; thinking?: string } | undefined
      if (delta?.type === 'text_delta' && delta.text) return delta.text
      if (delta?.type === 'thinking_delta' && delta.thinking) return `[thinking] ${delta.thinking}`
      return ''
    }
    case 'tool_use:start': {
      const name = (ev.data.name as string | undefined) ?? 'tool'
      const input = ev.data.input !== undefined ? JSON.stringify(ev.data.input) : ''
      return `\n[tool:start] ${name} ${input}\n`
    }
    case 'tool_use:done': {
      const output = ev.data.output !== undefined ? JSON.stringify(ev.data.output) : ''
      const truncated = output.length > 500 ? output.slice(0, 500) + '...(truncated)' : output
      return `[tool:done] ${truncated}\n`
    }
    case 'tool_use:error':
    case 'tool_use:invalid':
    case 'tool_use:denied': {
      const err = ev.data.error ?? ev.data
      return `[tool:${ev.type.replace('tool_use:', '')}] ${JSON.stringify(err)}\n`
    }
    case 'runtime.done':
      return `[done] ${(ev.data.text as string | undefined) ?? ''}\n`
    case 'runtime.error': {
      const err = ev.data.error as { message?: string } | undefined
      return `[error] ${err?.message ?? JSON.stringify(ev.data)}\n`
    }
    case 'runtime.aborted':
      return `[aborted] ${(ev.data.reason as string | undefined) ?? ''}\n`
    case 'message_stop':
    case 'message_start':
    case 'content_block_start':
    case 'content_block_stop':
    case 'message_delta':
      return ''
    default:
      return `[${ev.type}] ${JSON.stringify(ev.data)}\n`
  }
}

function eventsToText(events: TaskEvent[]): string {
  return events.map(eventToText).join('')
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n')
  if (lines.length <= n) return text
  return lines.slice(-n).join('\n')
}

/**
 * 暴露给 LLM 的「后台任务查询」工具。
 * 读取 events/<id>.log 最近 N 行 + 当前 status。
 */
export const BackgroundAgentResultTool: LegacyTool<typeof BackgroundAgentResultInputSchema, string> = {
  name: BACKGROUND_AGENT_RESULT_TOOL_NAME,
  description: renderBackgroundAgentResultPrompt(),
  inputSchema: BackgroundAgentResultInputSchema,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isDestructive: () => false,

  async call(rawInput, ctx) {
    const input = rawInput as BackgroundAgentResultInput
    if (!hasBackgroundRuntime()) {
      return {
        output:
          'BackgroundAgentResult 当前不可用:BackgroundRuntime 未初始化。',
        isError: true,
      }
    }
    try {
      const runtime = getBackgroundRuntime()
      const task = await runtime.get(input.shortId)
      if (!task) {
        return {
          output: `task not found: ${input.shortId}`,
          isError: true,
        }
      }

      // 可选等待(用于 polling 还在跑的任务)
      if (input.waitMs > 0 && (task.status === 'running' || task.status === 'queued')) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, input.waitMs)
          ctx.abortSignal?.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new Error('aborted while waiting'))
          }, { once: true })
        })
      }

      // 读所有事件(已完成任务),或读到当前 eventCount(运行中任务)
      const events: TaskEvent[] = []
      for await (const ev of runtime.events(input.shortId)) {
        events.push(ev)
      }

      const text = eventsToText(events)
      const tail = tailLines(text, input.tailLines)

      const header = [
        `id: ${task.id}`,
        `status: ${task.status}`,
        `prompt: ${task.input.prompt.slice(0, 100)}`,
        `createdAt: ${new Date(task.createdAt).toISOString()}`,
        task.startedAt ? `startedAt: ${new Date(task.startedAt).toISOString()}` : '',
        task.finishedAt ? `finishedAt: ${new Date(task.finishedAt).toISOString()}` : '',
        `events: ${events.length}`,
        task.error ? `error: ${task.error.message} (${task.error.category})` : '',
        task.resultText ? `resultText: ${task.resultText}` : '',
        '--- output (tail) ---',
      ]
        .filter(Boolean)
        .join('\n')

      return {
        output: `${header}\n${tail}`,
        isError: task.status === 'failed',
      }
    } catch (err) {
      return {
        output: `BackgroundAgentResult failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  },
}