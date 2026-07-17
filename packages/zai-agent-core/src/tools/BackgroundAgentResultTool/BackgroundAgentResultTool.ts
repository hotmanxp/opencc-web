import type { LegacyTool } from '../Tool.js'
import type { TaskEvent } from '../../runtime/background/types.js'
import {
  getBackgroundRuntime,
  hasBackgroundRuntime,
  type BackgroundTask,
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
 * Status-only output for the waitMs=0 path. Omits the `--- output (tail) ---`
 * block because the caller did not ask for events.
 */
function buildStatusOnlyHeader(task: BackgroundTask): string {
  const lines: string[] = [
    `id: ${task.id}`,
    `status: ${task.status}`,
    `prompt: ${task.input.prompt.slice(0, 100)}`,
    `createdAt: ${new Date(task.createdAt).toISOString()}`,
    task.startedAt ? `startedAt: ${new Date(task.startedAt).toISOString()}` : '',
    task.finishedAt ? `finishedAt: ${new Date(task.finishedAt).toISOString()}` : '',
    task.error ? `error: ${task.error.message} (${task.error.category})` : '',
    task.resultText ? `resultText: ${task.resultText}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * Wait up to `ms` milliseconds. Resolves early on `signal.abort`.
 * Never rejects — abort is a normal exit path.
 */
function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })
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

      // waitMs=0: 立即返回 status, 不进入 runtime.events()(其 live tail 会阻塞到任务结束)
      if (input.waitMs === 0) {
        return {
          output: buildStatusOnlyHeader(task),
          isError: task.status === 'failed',
        }
      }

      // waitMs>0: 等待指定时长(或 abort), 再读 events
      if (task.status === 'running' || task.status === 'queued') {
        await waitOrAbort(input.waitMs, ctx.abortSignal)
      }

      const events: TaskEvent[] = []
      for await (const ev of runtime.events(input.shortId, 0, ctx.abortSignal)) {
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