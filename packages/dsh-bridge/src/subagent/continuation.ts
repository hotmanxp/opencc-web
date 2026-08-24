/**
 * dsh-bridge continuable subagent 包装 — vendor `SubagentRuntime.startContinuable`。
 *
 * 与 one-shot 不同:continuable 子代理拥有持久 Session,支持多轮对话 + 冷恢复。
 * `ctx.subagents.startContinuable` 由 vendor `@deepseek-ai/dsh-subagent`
 * `SubagentRuntime` 暴露(内部委托给 `SubagentContinuationManager`)。
 *
 * 返回的 `childId` 是子 SessionId,`messageId` 是首条消息的 ID。
 * 后续消息走 `sendMessageToDshSubagent(ctx, childId, content)`(已存在)。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'

export interface ContinuableStartOpts {
  parentSessionId: string
  childId?: string
  prompt: string
  messageId?: string
}

export interface ContinuableStartResult {
  childId: string
  messageId: string
}

export async function startContinuable(
  ctx: Context,
  opts: ContinuableStartOpts,
): Promise<ContinuableStartResult> {
  const subagentRuntime = ctx.subagents as SubagentRuntime | undefined
  if (!subagentRuntime) {
    throw new Error(
      '[dsh-bridge] startContinuable: ctx.subagents.continuation unavailable — SubagentContinuationManager not loaded',
    )
  }

  const agentsService = ctx.get('agents') as { get: (id: string) => Agent | undefined } | undefined
  const parent = agentsService?.get(opts.parentSessionId)
  if (!parent) {
    throw new Error(
      `[dsh-bridge] startContinuable: parent agent not found for sessionId="${opts.parentSessionId}"`,
    )
  }

  const content: ContentBlock[] = [{ type: 'text', text: opts.prompt }]
  const spec = {
    provider: 'spawn',
    label: `dsh-continuable-${opts.childId ?? Date.now().toString(36)}`,
    ...(opts.childId !== undefined ? { childId: opts.childId as SessionId } : {}),
    request: {
      parent,
      prompt: content,
      ...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
    },
    signal: new AbortController().signal,
  }

  const result = await subagentRuntime.startContinuable(spec)
  return {
    childId: String(result.childId),
    messageId: String(result.messageId),
  }
}
