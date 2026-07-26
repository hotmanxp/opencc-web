/**
 * Compact conversation — streaming 摘要生成。
 *
 * 阶段 2 升级:
 * - 注入 serializeForCompact(thinking/tool_use/tool_result/image 完整版)
 * - 注入 estimateMessagesTokenCount(替代 messages.length * 100 占位)
 * - 调用 pre/post hooks(no-op 默认)
 * - PTL 错误透传(code: 'prompt_too_long'),重试由 compactSession shim 处理
 */

import { randomUUID } from 'node:crypto'
import type { TranscriptMessage } from '../../transcript/types.js'
import type { CompactionResult } from './types.js'
import { serializeForCompact } from './serialize-for-compact.js'
import { estimateMessagesTokenCount } from './token-estimate.js'
import { executePreCompactHooks, executePostCompactHooks } from './hooks.js'

type Message = TranscriptMessage

export type CompactModelCaller = (req: {
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
  modelCaller?: CompactModelCaller
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
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  _providerKind?: string,
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

  const trigger = isAutoCompact ? 'auto' : 'manual'

  const preHookResult = await executePreCompactHooks(
    { trigger, customInstructions: customInstructions ?? null },
    abortController.signal,
  )
  const effectiveInstructions = preHookResult.newCustomInstructions ?? customInstructions

  const systemPrompt =
    effectiveInstructions ??
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

  const hookResults = await executePostCompactHooks(
    { trigger, summary, messagesToKeep: [] },
    abortController.signal,
  )

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

  void suppressFollowUpQuestions

  return {
    boundaryMarker,
    summaryMessages: [summaryMessage],
    attachments: [],
    hookResults,
    preCompactTokenCount: estimateMessagesTokenCount(messages),
    postCompactTokenCount: estimateMessagesTokenCount([boundaryMarker, summaryMessage]),
  }
}