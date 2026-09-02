import type { SseFrame } from '../../lib/taskApi'

/**
 * 把 SSE `SseFrame` 翻译成结构化 `RenderedEvent`,按 RuntimeEvent 角色
 * (system / user / assistant-text / thinking / tool-use / tool-result /
 * task-ended) 分层渲染。纯函数,无副作用。
 *
 * 翻译规则见 spec §架构 / 翻译规则表。
 */

/** 任务终态。 */
export type TaskEndedStatus = 'completed' | 'failed' | 'cancelled'

/** 渲染层消费的结构化事件 —— superTasks/SuperTaskDetailDrawer 7 种 kind 分支。 */
export type RenderedEvent =
  | { kind: 'system'; ts: number; seq: number; sub: string }
  | { kind: 'user'; ts: number; seq: number; text: string; cwd?: string; agent?: string }
  | { kind: 'assistant-text'; ts: number; seq: number; text: string }
  | { kind: 'thinking'; ts: number; seq: number; text: string }
  | {
      kind: 'tool-use'
      ts: number
      seq: number
      name: string
      toolUseId: string
      summary: string
      fullInput: Record<string, unknown>
    }
  | {
      kind: 'tool-result'
      ts: number
      seq: number
      toolUseId: string
      isError: boolean
      summary: string
      fullContent: string
    }
  | { kind: 'task-ended'; status: TaskEndedStatus; error?: string; resultText?: string }

const SUM_PREFIX = 60
const BASH_CMD_PREFIX = 80
const JSON_FALLBACK_PREFIX = 80

/**
 * 把 SSE frame 翻译成渲染事件。无效/不识别的帧返回 null,绘制层
 * 会直接跳过(null 不进 timeline)。
 */
export function toRendered(frame: SseFrame): RenderedEvent | null {
  void frame
  return null
}
