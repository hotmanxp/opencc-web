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

/** RuntimeEvent type 集合(spec 翻译规则表 → assistant/user/system + tool_use/tool_result blocks)。 */
type RuntimeType = 'system' | 'user' | 'assistant'

/** 从外层 SSE data 抽出 {seq, ts},失败返回 null。 */
function readWireMeta(obj: Record<string, unknown>): { seq: number; ts: number } | null {
  const seq = obj.seq
  const ts = obj.ts
  if (typeof seq !== 'number' || typeof ts !== 'number') return null
  return { seq, ts }
}

/**
 * 把 SSE frame 翻译成渲染事件。无效/不识别的帧返回 null,绘制层
 * 会直接跳过(null 不进 timeline)。
 */
export function toRendered(frame: SseFrame): RenderedEvent | null {
  const d = frame.data
  if (d === null || typeof d !== 'object') return null
  const obj = d as Record<string, unknown>

  // 哨兵帧 task.ended
  if (frame.event === 'task.ended') {
    const status = obj.status
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
      return null
    }
    const out: RenderedEvent = { kind: 'task-ended', status }
    if (typeof obj.error === 'string') (out as { error?: string }).error = obj.error
    if (typeof obj.resultText === 'string')
      (out as { resultText?: string }).resultText = obj.resultText
    return out
  }

  // attach 路径:frame.data.data 是 stripMeta 后的 raw(没有 type 字段)
  const meta = readWireMeta(obj)
  if (!meta) return null
  const raw = obj.data
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const rawObj = raw as Record<string, unknown>

  // attach 帧的 RuntimeEvent type == frame.event(SSE event 字段;wire 内 type 同时存在但冗余)
  const t = frame.event as RuntimeType
  // 已知 RuntimeEvent 集合外:message_start / content_block_delta / ping 等显式 reject → null
  if (t !== 'system' && t !== 'user' && t !== 'assistant') return null

  // 后续 cycle 接入 system / user / assistant-text/thinking/tool-use/tool-result 分支
  void rawObj
  void meta
  return null
}
