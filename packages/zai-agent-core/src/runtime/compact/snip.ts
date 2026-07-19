/**
 * Snip:tokenCount ≥ effective_window * 0.95 时,削掉最早的 N 条 user 消息。
 *
 * 阶段 1 简化版:按 user 消息数粗估,不调 groupMessagesByApiRound。
 * 阶段 2(可选)再升级到精确 group 切分。
 */

import { getEffectiveContextWindowSize } from './context-window.js'
import type { TranscriptMessage } from '../../transcript/types.js'

export interface SnipBoundaryMessage {
  type: 'snip_boundary'
  message: { content: [{ type: 'text'; text: string }] }
}

export interface SnipResult {
  messages: TranscriptMessage[]
  tokensFreed: number
  boundaryMessage?: SnipBoundaryMessage
}

const SNIP_THRESHOLD_PCT = 0.95
const TOKENS_PER_USER_MSG = 2_000  // 粗估

export function snipCompactIfNeeded(
  messages: TranscriptMessage[],
  opts: { model: string },
): SnipResult {
  if (messages.length < 2) {
    return { messages, tokensFreed: 0 }
  }

  const effWindow = getEffectiveContextWindowSize(opts.model)
  const snipThreshold = effWindow * SNIP_THRESHOLD_PCT

  // 粗估 token count:user 消息数 * 平均 token
  const userMsgCount = messages.filter((m) => m.type === 'user').length
  const roughTokenCount = userMsgCount * TOKENS_PER_USER_MSG

  if (roughTokenCount < snipThreshold) {
    return { messages, tokensFreed: 0 }
  }

  // 削掉前 1/3 user 消息(粗略:保证剩 ≥ 2)
  const userMsgsToRemove = Math.max(1, Math.floor(userMsgCount / 3))
  const userMsgUuidsToRemove = new Set<string>()
  let removed = 0
  for (const m of messages) {
    if (m.type === 'user' && removed < userMsgsToRemove) {
      userMsgUuidsToRemove.add(m.uuid)
      removed++
    }
  }

  const remaining = messages.filter((m) => !userMsgUuidsToRemove.has(m.uuid))
  if (remaining.length === messages.length) {
    return { messages, tokensFreed: 0 }
  }

  const boundary: SnipBoundaryMessage = {
    type: 'snip_boundary',
    message: { content: [{ type: 'text', text: `已 snip 掉 ${userMsgsToRemove} 条早期消息` }] },
  }

  return {
    messages: remaining,
    tokensFreed: removed * TOKENS_PER_USER_MSG,
    boundaryMessage: boundary,
  }
}
