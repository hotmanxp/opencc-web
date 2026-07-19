/**
 * Compact conversation — streaming 摘要生成。
 *
 * 阶段 1 简化版:不实现 PTL 自愈 / prompt cache sharing / pre/post hooks
 * (这些留到阶段 2)。
 *
 * 调用 modelCaller 流式生成 summary,构造 boundary + summary message,
 * 返回 CompactionResult。
 */

import { randomUUID } from 'node:crypto'
import type { TranscriptMessage } from '../../transcript/types.js'
import type { CompactionResult } from './types.js'

// ---- 本地最小类型:避免依赖 opencc-internals / runtime/types.js ----
type Message = TranscriptMessage

type ModelCaller = (req: {
  model: string
  systemPrompt: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  tools: unknown[]
  signal?: AbortSignal
}) => AsyncIterable<{
  type: string
  index?: number
  content_block?: { type: string; text?: string }
  delta?: { type: string; text?: string }
}>

type ToolUseContext = {
  options: { mainLoopModel: string }
  abortController: AbortController
  modelCaller?: ModelCaller
}

type CacheSafeParams = {
  systemPrompt: unknown
  userContext: Record<string, unknown>
  systemContext: Record<string, unknown>
  toolUseContext: unknown
  forkContextMessages: Message[]
}

const COMPACT_TIMEOUT_MS = 120_000

export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ]
}

export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  _cacheSafeParams: CacheSafeParams,
  _suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
): Promise<CompactionResult> {
  if (messages.length === 0) {
    throw new Error('Not enough messages to compact.')
  }

  const lastMsg = messages[messages.length - 1]!
  const modelCaller = context.modelCaller
  if (!modelCaller) {
    throw new Error('compact: context.modelCaller is required')
  }

  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), COMPACT_TIMEOUT_MS)

  const systemPrompt =
    customInstructions ??
    '你是一个对话摘要助手。把以下对话历史压缩成精炼的中文摘要,不超过 800 字。'

  const summaryRequest = {
    model: context.options.mainLoopModel,
    systemPrompt,
    messages: [
      {
        role: 'user' as const,
        content: `请压缩以下 ${messages.length} 条对话历史为摘要:\n\n${serializeForCompact(messages)}`,
      },
    ],
    tools: [],
    signal: abortController.signal,
  }

  let summary = ''
  let sawMessageStop = false
  try {
    const stream = modelCaller(summaryRequest)
    for await (const ev of stream) {
      if (
        ev.type === 'content_block_delta' &&
        ev.delta?.type === 'text_delta' &&
        typeof ev.delta.text === 'string'
      ) {
        summary += ev.delta.text
      }
      if (ev.type === 'message_stop') {
        sawMessageStop = true
        break
      }
    }
  } finally {
    clearTimeout(timer)
  }

  if (!sawMessageStop) {
    throw new Error('compact: 未收到 message_stop')
  }
  summary = summary.trim()
  if (!summary) {
    throw new Error('compact: 模型返回空 summary')
  }

  const lastTurn = (lastMsg.runtime?.turnIndex ?? 0) + 1

  const boundaryMarker: TranscriptMessage = {
    uuid: randomUUID(),
    parentUuid: lastMsg.uuid,
    type: 'system',
    timestamp: Date.now(),
    raw: null,
    runtime: { turnIndex: lastTurn },
    version: '2',
    message: {
      content: [
        { type: 'text', text: '对话从这之后被压缩为摘要。详细历史已归档。' },
      ],
      // 与 compactService.ts 同样的取舍: 'system' 在 AnthropicMessage.role
      // (transcript/types.ts:110) 不允许, cast 成 'user'|'assistant'。
      // 该字段是 dead data — queryEngine 按 tm.type 派生 role, 不读
      // message.role; serializeForAnthropic 也跳过 compact_boundary 类型。
      role: 'system' as 'user' | 'assistant',
    },
    cwd: lastMsg.cwd ?? '/',
    sessionId: lastMsg.sessionId ?? 'sess-unknown',
    userType: 'zai',
    isSidechain: false,
  }

  const summaryMessage: TranscriptMessage = {
    uuid: randomUUID(),
    parentUuid: boundaryMarker.uuid,
    type: 'assistant',
    timestamp: Date.now() + 1,
    raw: null,
    runtime: { turnIndex: lastTurn },
    version: '2',
    message: {
      content: [{ type: 'text', text: summary }],
      role: 'assistant',
    },
    cwd: lastMsg.cwd ?? '/',
    sessionId: lastMsg.sessionId ?? 'sess-unknown',
    userType: 'zai',
    isSidechain: false,
  }

  // isAutoCompact 留到阶段 2 在 hook 里消费
  void isAutoCompact

  return {
    boundaryMarker,
    summaryMessages: [summaryMessage],
    attachments: [],
    hookResults: [],
    preCompactTokenCount: messages.length * 100,
    postCompactTokenCount: summary.length * 2,
  }
}

function serializeForCompact(messages: Message[]): string {
  return messages
    .map((m) => {
      const content = m.message?.content
      if (typeof content === 'string') return `[${m.type}] ${content}`
      const blocks = Array.isArray(content) ? content : []
      return `[${m.type}] ${blocks.map((b: any) => b.text ?? '').join('')}`
    })
    .join('\n\n')
}