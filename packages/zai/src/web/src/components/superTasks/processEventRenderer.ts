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

interface MessageWire {
  message?: { content?: unknown }
  [k: string]: unknown
}

/** 从外层 SSE data 抽出 {seq, ts},失败返回 null。 */
function readWireMeta(obj: Record<string, unknown>): { seq: number; ts: number } | null {
  const seq = obj.seq
  const ts = obj.ts
  if (typeof seq !== 'number' || typeof ts !== 'number') return null
  return { seq, ts }
}

/** 从 raw 抽 message.content 数组,失败返回 null。 */
function readContent(raw: Record<string, unknown>): unknown[] | null {
  const m = raw.message as MessageWire['message']
  if (!m || typeof m !== 'object') return null
  const c = m.content
  if (!Array.isArray(c)) return null
  return c
}

/** content[0] 决定 assistant frame 的 kind;text / thinking / tool_use 三选一。 */
function renderAssistant(
  meta: { seq: number; ts: number },
  raw: Record<string, unknown>,
): RenderedEvent | null {
  const content = readContent(raw)
  if (!content) return null
  const block = content[0] as Record<string, unknown> | undefined
  if (!block || typeof block !== 'object') return null
  const t = block.type
  if (t === 'text') {
    const text = typeof block.text === 'string' ? block.text : ''
    return { kind: 'assistant-text', seq: meta.seq, ts: meta.ts, text }
  }
  if (t === 'thinking') {
    const text = typeof block.text === 'string' ? block.text : ''
    return { kind: 'thinking', seq: meta.seq, ts: meta.ts, text }
  }
  if (t === 'tool_use') {
    return renderToolUse(meta, block)
  }
  return null
}

/** tool_use block → 一行 summary(8 个工具名特定规则)。 */
function renderToolUse(
  meta: { seq: number; ts: number },
  block: Record<string, unknown>,
): RenderedEvent | null {
  const id = block.id
  const name = block.name
  if (typeof id !== 'string' || typeof name !== 'string') return null
  const input =
    block.input && typeof block.input === 'object'
      ? (block.input as Record<string, unknown>)
      : {}

  let summary: string
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      summary = typeof input.file_path === 'string' ? input.file_path : fallback(input)
      break
    case 'Bash':
      summary =
        typeof input.command === 'string'
          ? input.command.slice(0, BASH_CMD_PREFIX)
          : fallback(input)
      break
    case 'Grep':
      summary = typeof input.pattern === 'string' ? input.pattern : fallback(input)
      break
    case 'Glob':
      summary =
        typeof input.pattern === 'string'
          ? `${input.pattern} · ${typeof input.path === 'string' ? input.path : ''}`
          : fallback(input)
      break
    case 'Agent':
    case 'Task':
      if (typeof input.description === 'string') summary = input.description
      else if (typeof input.prompt === 'string') summary = input.prompt.slice(0, SUM_PREFIX)
      else summary = fallback(input)
      break
    default:
      summary = fallback(input)
  }

  return {
    kind: 'tool-use',
    seq: meta.seq,
    ts: meta.ts,
    name,
    toolUseId: id,
    summary,
    fullInput: input,
  }
}

function fallback(input: Record<string, unknown>): string {
  return JSON.stringify(input).slice(0, JSON_FALLBACK_PREFIX)
}

/** content[0] 决定 user frame 的 kind;text → user,tool_result → tool-result。 */
function renderUser(
  meta: { seq: number; ts: number },
  raw: Record<string, unknown>,
): RenderedEvent | null {
  const content = readContent(raw)
  if (!content) return null
  const block = content[0] as Record<string, unknown> | undefined
  if (!block || typeof block !== 'object') return null
  const t = block.type
  if (t === 'text') {
    const out: RenderedEvent = {
      kind: 'user',
      seq: meta.seq,
      ts: meta.ts,
      text: typeof block.text === 'string' ? block.text : '',
    }
    if (typeof raw.cwd === 'string') (out as { cwd?: string }).cwd = raw.cwd
    if (typeof raw.agent === 'string') (out as { agent?: string }).agent = raw.agent
    return out
  }
  if (t === 'tool_result') {
    return renderToolResult(meta, block)
  }
  return null
}

/** tool_result block → 摘要 (首行 + 长度),is_error 透传。 */
function renderToolResult(
  meta: { seq: number; ts: number },
  block: Record<string, unknown>,
): RenderedEvent | null {
  const toolUseId = block.tool_use_id
  if (typeof toolUseId !== 'string') return null
  const rawContent = block.content
  if (rawContent === null || rawContent === undefined) return null

  let fullContent: string
  if (typeof rawContent === 'string') {
    fullContent = rawContent
  } else if (Array.isArray(rawContent)) {
    const parts: string[] = []
    for (const p of rawContent) {
      if (!p || typeof p !== 'object') continue
      const pp = p as Record<string, unknown>
      if (pp.type === 'text' && typeof pp.text === 'string') parts.push(pp.text)
      // image / document 等非 text block 跳过
    }
    fullContent = parts.join('')
  } else {
    return null
  }

  const firstLine = fullContent.split('\n', 1)[0] ?? ''
  const summary = firstLine.length > 0
    ? `${firstLine} (${fullContent.length} chars)`
    : `(${fullContent.length} chars)`
  const isError = block.is_error === true
  return {
    kind: 'tool-result',
    seq: meta.seq,
    ts: meta.ts,
    toolUseId,
    isError,
    summary,
    fullContent,
  }
}

/** system frame 只看 subtype 字段。 */
function renderSystem(
  meta: { seq: number; ts: number },
  raw: Record<string, unknown>,
): RenderedEvent | null {
  const sub = raw.subtype
  if (typeof sub !== 'string' || sub.length === 0) return null
  return { kind: 'system', seq: meta.seq, ts: meta.ts, sub }
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

  switch (t) {
    case 'system':
      return renderSystem(meta, rawObj)
    case 'user':
      return renderUser(meta, rawObj)
    case 'assistant':
      return renderAssistant(meta, rawObj)
  }
}
