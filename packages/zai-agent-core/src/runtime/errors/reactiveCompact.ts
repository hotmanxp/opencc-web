/**
 * A.4 Reactive compact stub (tryReactiveCompact).
 *
 * spec §2.1 / §3 行为 14-16:
 * - Stage 1 compactConversation 不存在 → kind:'unimplemented'
 * - Stage 1 存在 + 成功 → kind:'attempted' + newMessages (boundary + summary)
 * - Stage 1 存在 + 抛错 → kind:'failed',**不抛**
 *
 * 动态 import runtime/compact/conversation.ts — Stage 1 不可用时返 stub。
 * 完整 reactive path 留给 Stage 2。
 */

import type { AnthropicMessage, TranscriptMessage } from '../../transcript/types.js'
import type { ModelCaller } from '../types.js'

export interface ReactiveCompactResult {
  kind: 'attempted' | 'unimplemented' | 'failed'
  newMessages?: AnthropicMessage[]
  reason?: string
}

type CompactConversationFn = (
  messages: TranscriptMessage[],
  context: {
    options: { mainLoopModel: string }
    abortController: AbortController
    modelCaller: ModelCaller
  },
  cacheSafeParams: unknown,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact?: boolean,
) => Promise<{
  boundaryMarker: TranscriptMessage
  summaryMessages: TranscriptMessage[]
  attachments: TranscriptMessage[]
  hookResults: TranscriptMessage[]
  messagesToKeep?: TranscriptMessage[]
  preCompactTokenCount?: number
  postCompactTokenCount?: number
}>

type BuildPostCompactMessagesFn = (result: {
  boundaryMarker: TranscriptMessage
  summaryMessages: TranscriptMessage[]
  attachments: TranscriptMessage[]
  hookResults: TranscriptMessage[]
  messagesToKeep?: TranscriptMessage[]
}) => TranscriptMessage[]

/**
 * Local minimal buildPostCompactMessages impl — re-derives the boundary /
 * summary / keep / attachments / hookResults order without depending on
 * runtime/compact/conversation.ts (so a mock that nukes the latter
 * can't break our stub). Mirrors runtime/compact/conversation.ts:46-54.
 */
function localBuildPostCompactMessages(result: {
  boundaryMarker: TranscriptMessage
  summaryMessages: TranscriptMessage[]
  attachments: TranscriptMessage[]
  hookResults: TranscriptMessage[]
  messagesToKeep?: TranscriptMessage[]
}): TranscriptMessage[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ]
}

export async function tryReactiveCompact(
  messages: AnthropicMessage[],
  modelCaller: ModelCaller,
  signal: AbortSignal,
): Promise<ReactiveCompactResult> {
  try {
    // 单一动态 import — Stage 1 不存在时 resolve 成 null/undefined
    const mod: any = await import('../compact/conversation.js').catch(() => null)
    if (!mod) return { kind: 'unimplemented' }

    const compactConversation: CompactConversationFn | undefined = mod?.compactConversation
    const buildPostCompactMessages: BuildPostCompactMessagesFn | undefined =
      mod?.buildPostCompactMessages ?? localBuildPostCompactMessages

    if (typeof compactConversation !== 'function') {
      return { kind: 'unimplemented' }
    }

    if (signal.aborted) {
      return { kind: 'unimplemented', reason: 'aborted' }
    }

    // 把 AnthropicMessage[] 转 TranscriptMessage[] 喂给 compactConversation
    const baseTs = Date.now()
    const transcriptMessages: TranscriptMessage[] = messages.map(
      (m, i): TranscriptMessage => ({
        uuid: `react-${baseTs}-${i}`,
        parentUuid: i > 0 ? `react-${baseTs}-${i - 1}` : null,
        type: m.role,
        timestamp: baseTs + i,
        raw: null,
        runtime: { turnIndex: 0 },
        version: '2',
        message: m,
        cwd: '/',
        sessionId: 'sess-reactive',
        userType: 'zai',
        isSidechain: false,
      }),
    )

    const abortController = new AbortController()
    if (signal) {
      signal.addEventListener(
        'abort',
        () => abortController.abort(signal.reason),
        { once: true },
      )
    }

    try {
      const result = await compactConversation(
        transcriptMessages,
        {
          options: { mainLoopModel: 'MiniMax-M3' },
          abortController,
          modelCaller,
        },
        { systemPrompt: '', userContext: {}, systemContext: {}, toolUseContext: null, forkContextMessages: [] },
        true,
        undefined,
        false,
      )

      const post = (buildPostCompactMessages ?? localBuildPostCompactMessages)(result)
      // 把 TranscriptMessage[] 转回 AnthropicMessage[]
      const newMessages: AnthropicMessage[] = post.map((tm): AnthropicMessage => {
        const content = tm.message?.content
        if (typeof content === 'string') {
          return { role: tm.type === 'assistant' ? 'assistant' : 'user', content }
        }
        if (Array.isArray(content)) {
          return {
            role: tm.type === 'assistant' ? 'assistant' : 'user',
            content: content as any,
          }
        }
        return { role: 'user', content: '' }
      })

      return { kind: 'attempted', newMessages }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { kind: 'failed', reason }
    }
  } catch (err) {
    // 永不抛 — 任何意外走 unimplemented 兜底
    return { kind: 'unimplemented' }
  }
}