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

/**
 * 解开外层 `.raw` 包裹(zai 真实 wire 把 raw event 整个嵌在 `.data.raw` 里),
 * 无包裹时退回 rawObj 本身。返回的 raw 字段(layout)与 spec 翻译表对齐:
 * raw.type/subtype/message.content/cwd/agent。
 */
function unwrapRaw(rawObj: Record<string, unknown>): Record<string, unknown> {
  const inner = rawObj.raw
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, unknown>
  }
  return rawObj
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
    if (text.length === 0) {
      // streaming thinking delta:thinking 字段(Anthropic)
      const thinking = typeof block.thinking === 'string' ? block.thinking : ''
      return { kind: 'thinking', seq: meta.seq, ts: meta.ts, text: thinking }
    }
    return { kind: 'thinking', seq: meta.seq, ts: meta.ts, text }
  }
  if (t === 'tool_use') {
    return renderToolUse(meta, block)
  }
  return null
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

/** system frame 只看 subtype 字段。 */
function renderSystem(
  meta: { seq: number; ts: number },
  raw: Record<string, unknown>,
): RenderedEvent | null {
  const sub = raw.subtype
  if (typeof sub !== 'string' || sub.length === 0) return null
  return { kind: 'system', seq: meta.seq, ts: meta.ts, sub }
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

function fallback(input: Record<string, unknown>): string {
  return JSON.stringify(input).slice(0, JSON_FALLBACK_PREFIX)
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

  // attach 路径:frame.data.data 是 stripMeta 后的 raw(没有顶层 type 字段,
  // 真实 raw 包在 .raw 子层里)
  const meta = readWireMeta(obj)
  if (!meta) return null
  const raw = obj.data
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const rawWrapped = raw as Record<string, unknown>

  // attach 帧的 RuntimeEvent type == frame.event(SSE event 字段;wire 内 type 同时存在但冗余)
  const t = frame.event

  // dsh(CliAgent attach)走 mapSubagentBgEventType 词汇表:assistant_message /
  // tool_use / tool_result / subagent_turn_started / _completed。agent=opencc 的
  // system|user|assistant 词汇表在下面 switch 分支保持原路径,完全不受影响。
  switch (t) {
    case 'assistant_message': {
      // 逐 token delta,文本取 data.text;相邻碎片由 mergeConsecutiveAssistantText 折叠。
      const text = typeof rawWrapped.text === 'string' ? rawWrapped.text : ''
      return { kind: 'assistant-text', seq: meta.seq, ts: meta.ts, text }
    }
    case 'tool_use': {
      // dsh 把入参塞在 .raw.{id,name,input},input 是 JSON 字符串,且工具名为小写;
      // 解析 + 规范大小写后复用 renderToolUse 的既有 summary 规则。
      const payload = asRecord(rawWrapped.raw) ?? rawWrapped
      const id = payload.id
      const name = payload.name
      if (typeof id !== 'string' || typeof name !== 'string') return null
      return renderToolUse(meta, { id, name: canonicalToolName(name), input: parseToolInput(payload.input) })
    }
    case 'tool_result': {
      // dsh tool_result 只带 tool_use_id(无 content)→ 空摘要;若带 content 则走原规则。
      const payload = asRecord(rawWrapped.raw) ?? rawWrapped
      const toolUseId = payload.tool_use_id
      if (typeof toolUseId !== 'string') return null
      if (payload.content === null || payload.content === undefined) {
        return {
          kind: 'tool-result',
          seq: meta.seq,
          ts: meta.ts,
          toolUseId,
          isError: payload.is_error === true,
          summary: '',
          fullContent: '',
        }
      }
      return renderToolResult(meta, payload)
    }
    // 轮次标记不渲染(保持 Timeline 干净);未知/流式碎片(message_start /
    // content_block_delta / commentary / ping)显式 null,绘制层跳过。
    case 'subagent_turn_started':
    case 'subagent_turn_completed':
    case 'commentary':
      return null
    case 'system':
      return renderSystem(meta, unwrapRaw(rawWrapped))
    case 'user':
      return renderUser(meta, unwrapRaw(rawWrapped))
    case 'assistant':
      return renderAssistant(meta, unwrapRaw(rawWrapped))
    default:
      return null
  }
}

/**
 * dsh provider 用小写工具名(read/bash/grep…),而 renderToolUse 的 8 条 summary
 * 规则按 PascalCase(opencc 习惯)匹配。这里把已知小写名规范成 PascalCase,让 dsh
 * 工具行也能拿到与 opencc 一致的摘要;未知名原样透传(命中 renderToolUse 的
 * fallback 分支)。
 */
const DSH_TOOL_ALIASES: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  agent: 'Agent',
  task: 'Task',
}

function canonicalToolName(name: string): string {
  return DSH_TOOL_ALIASES[name.toLowerCase()] ?? name
}

/** 解 dsh tool_use 的 input:字符串按 JSON.parse,对象直接用,其余给空对象。 */
function parseToolInput(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // 非 JSON 字符串 → 空 input,renderToolUse 走 fallback 摘要
    }
    return {}
  }
  return asRecord(input) ?? {}
}

/** 非数组对象断言助手,否则 null。 */
function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return null
}

/**
 * 把连续的 assistant-text 帧折叠成一条 —— dsh(CliAgent)以逐 token delta 上报
 * assistant_message(单任务可达上千帧),不折叠会把 200 帧缓冲塞满碎片、Timeline
 * 也无法阅读。合并后计数 badge / slice(-20) 窗口按「回合」而非碎片计,更合理。
 * 合并保留每条 run 首帧的 seq/ts(rowKey 依赖 seq,保持稳定)。
 */
export function mergeConsecutiveAssistantText(events: RenderedEvent[]): RenderedEvent[] {
  const out: RenderedEvent[] = []
  for (const ev of events) {
    const last = out[out.length - 1]
    if (ev.kind === 'assistant-text' && last && last.kind === 'assistant-text') {
      out[out.length - 1] = { ...last, text: last.text + ev.text }
      continue
    }
    out.push(ev)
  }
  return out
}
